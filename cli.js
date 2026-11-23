#!/usr/bin/env node
/**
 * Watch or download movies and TV shows from the terminal.
 *
 * Requires: Node 20+, ffmpeg (download), mpv or IINA on macOS (watch).
 * Config (.env file or environment): TMDB_KEY (required), WYZIE_KEY (optional, extra subtitles).
 * Optional: PLAYER=<command> to use a different mpv-compatible player.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

await import('dotenv/config').catch(() => {}); // optional: loads .env when dotenv is installed

const { TMDB_KEY, WYZIE_KEY } = process.env;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ORIGIN = 'https://www.movy.sx';
const REFERER = `${ORIGIN}/`;
const API_HEADERS = { Accept: '*/*', Origin: ORIGIN, Referer: REFERER, 'User-Agent': UA };
const FFMPEG_HEADERS = `Referer: ${REFERER}\r\nOrigin: ${ORIGIN}\r\n`;
const SERVERS = [
  'miami', 'boise', 'vegas', 'reno', 'oakland', 'seattle',
  'phoenix', 'atlanta', 'portland', 'austin', 'dallas',
];
const MAX_SUBS = 3;
const CONCURRENCY = 16; // parallel HLS segment downloads
const SEGMENT_WINDOW = CONCURRENCY * 2; // max segments buffered in memory ahead of the write position

const BACK = Symbol('back');
const EXIT = Symbol('exit');
const NEXT = Symbol('next'); // step finished after asking the user something
const AUTO = Symbol('auto'); // step finished without needing input (skipped when going back)

// ---------- Cleanup & signals ----------
const cleanups = new Set();
const onCleanup = (fn) => {
  cleanups.add(fn);
  return () => cleanups.delete(fn);
};
process.on('exit', () => {
  for (const fn of cleanups) {
    try { fn(); } catch {}
  }
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n⏹  Cancelled.');
    process.exit(130);
  });
}

let tmpRoot = null;
function getTmp() {
  if (!tmpRoot) {
    tmpRoot = mkdtempSync(join(tmpdir(), 'streamcli-'));
    onCleanup(() => rmSync(tmpRoot, { recursive: true, force: true }));
  }
  return tmpRoot;
}

// ---------- Arguments ----------
function printUsage(out = console.error) {
  out('Usage:');
  out('  node cli.js                                interactive mode');
  out('  node cli.js watch|download "Title" [options]');
  out('');
  out('Options:');
  out('  -s <n> -e <n>   season / episode (TV shows)');
  out('  -q <quality>    1080, 720, 4k, best, worst');
  out('  -l <lang>       subtitle language for extra subtitles (default: en)');
  out('  --no-subs       skip subtitles');
  out('  --compress      re-encode to smaller H.264 (download only)');
  out('  -h, --help      show this help');
}
function fail(msg) {
  console.error(`❌ ${msg}\n`);
  printUsage();
  process.exit(1);
}
const toInt = (v) => (/^\d{1,4}$/.test(String(v ?? '').trim()) ? parseInt(v, 10) : null);

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  printUsage(console.log);
  process.exit(0);
}

const command = ['watch', 'download'].includes(argv[0]) ? argv[0] : null;
const rest = command ? argv.slice(1) : argv;
const opts = { season: null, episode: null, quality: null, lang: 'en', compress: false, subs: true };
const titleParts = [];

for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  const val = () => {
    if (i + 1 >= rest.length) fail(`Missing value for ${a}`);
    return rest[++i];
  };
  if (a === '-s') {
    opts.season = toInt(val());
    if (opts.season === null) fail('Season must be a number.');
  } else if (a === '-e') {
    opts.episode = toInt(val());
    if (opts.episode === null || opts.episode < 1) fail('Episode must be a positive number.');
  } else if (a === '-q') opts.quality = val().toLowerCase();
  else if (a === '-l') {
    opts.lang = val().toLowerCase();
    if (!/^[a-z]{2,3}(-[a-z]{2,4})?$/.test(opts.lang)) fail('Invalid language code.');
  } else if (a === '--compress') opts.compress = true;
  else if (a === '--no-subs') opts.subs = false;
  else if (a.startsWith('-') && a.length > 1) fail(`Unknown option: ${a}`);
  else titleParts.push(a);
}

if (!TMDB_KEY) {
  console.error('❌ TMDB_KEY is not set. Put it in a .env file or export it as an environment variable.');
  process.exit(1);
}

const ctx = {
  command,
  query: '',
  id: null, type: null, title: '', year: '',
  seasons: undefined, season: null, episode: null,
  streamKey: '', sources: [], nativeSub: null, chosen: null,
  subsKey: '', subs: [],
};
const preset = {
  query: titleParts.join(' ').trim() || null,
  season: opts.season,
  episode: opts.episode,
  quality: opts.quality,
};

// ---------- Prompts ----------
function question(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    const done = (v) => {
      if (!settled) { settled = true; resolve(v); }
    };
    rl.on('SIGINT', () => rl.close());
    rl.on('close', () => done(null)); // Ctrl+C / Ctrl+D
    rl.question(q, (a) => { done(a); rl.close(); });
  });
}

async function ask(prompt, { back = true } = {}) {
  const hint = back ? 'b = back, x = exit' : 'x = exit';
  const answer = await question(`${prompt} (${hint}): `);
  if (answer === null) return EXIT;
  const v = answer.trim();
  const l = v.toLowerCase();
  if (l === 'x' || l === 'exit' || l === 'quit') return EXIT;
  if (back && (l === 'b' || l === 'back')) return BACK;
  return v;
}

// ---------- Helpers ----------
const pad = (n) => String(n).padStart(2, '0');
const toSec = (t) => {
  const [h, m, s] = t.split(':');
  return +h * 3600 + +m * 60 + parseFloat(s);
};
const fmtTime = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
};
const fmtBytes = (n) =>
  n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : `${(n / 1048576).toFixed(1)} MB`;
const bar = (pct, width = 20) => {
  const f = Math.round((pct / 100) * width);
  return `[${'█'.repeat(f)}${'░'.repeat(width - f)}]`;
};
const isHttpUrl = (u) => {
  try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; }
};
const hasBin = (bin) =>
  !spawnSync(bin, [bin === 'ffmpeg' ? '-version' : '--version'], { stdio: 'ignore' }).error;

// Live status line (single line, truncated so it never wraps)
let statusLen = 0;
function status(text) {
  const t = text.slice(0, (process.stdout.columns || 100) - 1);
  process.stdout.write(`\r${t.padEnd(statusLen)}`);
  statusLen = t.length;
}
function clearStatus() {
  if (statusLen) process.stdout.write(`\r${' '.repeat(statusLen)}\r`);
  statusLen = 0;
}

// fetch with timeout, retries and abort support. Never log URLs: they can contain API keys.
async function http(url, { retries = 2, timeout = 15000, signal, ...init } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const sig = signal ? AbortSignal.any([AbortSignal.timeout(timeout), signal]) : AbortSignal.timeout(timeout);
      const res = await fetch(url, { ...init, signal: sig });
      if (res.ok) return res;
      res.body?.cancel().catch(() => {});
      const err = new Error(`HTTP ${res.status}`);
      if (res.status < 500 && res.status !== 429) err.fatal = true; // client errors won't fix themselves
      throw err;
    } catch (e) {
      lastErr = e;
      if (e.fatal || signal?.aborted) break;
    }
    if (attempt < retries) await sleep(400 * (attempt + 1));
  }
  throw lastErr;
}

// ---------- TMDB ----------
async function tmdb(path, params = {}) {
  const qs = new URLSearchParams({ api_key: TMDB_KEY, ...params });
  try {
    return await (await http(`https://api.themoviedb.org/3${path}?${qs}`)).json();
  } catch (e) {
    if (e.message === 'HTTP 401') throw new Error('TMDB rejected the API key. Check TMDB_KEY.');
    throw new Error(`TMDB request failed: ${e.message}`);
  }
}

async function searchTitle(query) {
  const data = await tmdb('/search/multi', { query, include_adult: 'false' });
  return (data.results || []).filter((r) => r.media_type === 'movie' || r.media_type === 'tv').slice(0, 8);
}

async function loadSeasons(id) {
  try {
    const d = await tmdb(`/tv/${id}`);
    const seasons = (d.seasons || []).map((s) => ({ number: s.season_number, count: s.episode_count }));
    return seasons.length ? seasons : null;
  } catch {
    return null; // validation is a nicety; carry on without it
  }
}

function nextEpisode() {
  if (ctx.type !== 'tv') return null;
  if (!ctx.seasons) return { season: ctx.season, episode: ctx.episode + 1 };
  const cur = ctx.seasons.find((x) => x.number === ctx.season);
  if (cur?.count && ctx.episode < cur.count) return { season: ctx.season, episode: ctx.episode + 1 };
  const nxt = ctx.seasons.find((x) => x.number > ctx.season && x.count > 0);
  return nxt ? { season: nxt.number, episode: 1 } : null;
}

// ---------- Stream lookup ----------
const qualityValue = (q) => {
  const s = String(q).toLowerCase();
  if (s.includes('4k')) return 2160;
  const m = s.match(/(\d{3,4})/);
  return m ? +m[1] : 0;
};

function matchQuality(list, q) {
  if (q === 'best') return list[0];
  if (q === 'worst') return list.at(-1);
  const wanted = q.replace('4k', '2160');
  return list.find((s) => String(s.quality).toLowerCase().replace('4k', '2160').includes(wanted));
}

async function findStreams() {
  const { id, type, title, year, season, episode } = ctx;
  const seed = (await (await http(`https://api.wecollege.net/seed?mediaId=${id}`, { headers: API_HEADERS })).json()).seed;
  if (!seed) throw new Error('Failed to get seed.');

  const encTitle = encodeURIComponent(encodeURIComponent(title));
  const ac = new AbortController();

  // Probe all servers at once and take the first that returns usable sources.
  const probe = async (server) => {
    let url = `https://api.wecollege.net/${server}/sources?title=${encTitle}&mediaType=${type}&year=${year}&tmdbId=${id}&imdbId=&enc=2&seed=${encodeURIComponent(seed)}`;
    if (type === 'tv') url += `&seasonId=${season}&episodeId=${episode}`;

    const text = await (await http(url, { headers: API_HEADERS, signal: ac.signal, retries: 0, timeout: 12000 })).text();
    if (text.length < 50) throw new Error('empty response');
    try {
      if (JSON.parse(text)?.error) throw new Error('server error'); // plain JSON means an error payload
    } catch (e) {
      if (e.message === 'server error') throw e; // otherwise it's the encrypted payload we want
    }

    const dec = await http('https://enc-dec.app/api/dec-videasy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, id, seed }),
      signal: ac.signal,
      retries: 0,
    });
    const data = await dec.json();
    const sources = (data?.status === 200 ? data.result?.sources || [] : []).filter((s) => s?.url && isHttpUrl(s.url));
    if (!sources.length) throw new Error('no sources');
    const sub = data.result.subtitles?.find((s) => s?.url && isHttpUrl(s.url));
    return { server, sources, sub };
  };

  try {
    return await Promise.any(SERVERS.map(probe));
  } catch {
    return null;
  } finally {
    ac.abort();
  }
}

// ---------- Subtitles ----------
async function grabSub(url, ext, label, headers) {
  if (!isHttpUrl(url)) return null;
  try {
    const buf = Buffer.from(await (await http(url, { headers, retries: 1 })).arrayBuffer());
    if (!buf.length || buf.length > 5_000_000) return null;
    return { buf, ext, label: String(label).slice(0, 40) };
  } catch {
    return null;
  }
}

async function fetchSubtitles() {
  const native = ctx.nativeSub
    ? grabSub(ctx.nativeSub.url, 'vtt', ctx.nativeSub.language || ctx.nativeSub.lang || ctx.nativeSub.label || 'Default', API_HEADERS)
    : Promise.resolve(null);

  let extra = [];
  if (WYZIE_KEY) {
    try {
      const params = new URLSearchParams({ id: ctx.id, language: opts.lang, key: WYZIE_KEY });
      if (ctx.type === 'tv') {
        params.append('season', ctx.season);
        params.append('episode', ctx.episode);
      }
      const list = await (await http(`https://sub.wyzie.io/search?${params}`)).json();
      if (Array.isArray(list)) {
        extra = list
          .filter((x) => x?.url)
          .slice(0, MAX_SUBS - (ctx.nativeSub ? 1 : 0))
          .map((x) => grabSub(x.url, ['srt', 'vtt', 'ass'].includes(x.format) ? x.format : 'srt', x.display || x.language || 'Subtitle', {}));
      }
    } catch (e) {
      console.log(`⚠️  Wyzie subtitle search failed: ${e.message}`);
    }
  }

  const dir = mkdtempSync(join(getTmp(), 'subs-'));
  const out = [];
  for (const r of (await Promise.all([native, ...extra])).filter(Boolean).slice(0, MAX_SUBS)) {
    const file = join(dir, `sub_${out.length + 1}.${r.ext}`);
    writeFileSync(file, r.buf);
    out.push({ file, label: r.label });
  }
  return out;
}

// ---------- Watch ----------
function watch() {
  const mac = platform() === 'darwin';
  let player = process.env.PLAYER || (mac ? 'iina' : 'mpv');

  // 🧠 Auto-detect common install paths if the player isn't in the system PATH
  if (!hasBin(player)) {
    if (player === 'iina') {
      const iinaPath = '/Applications/IINA.app/Contents/MacOS/iina';
      if (existsSync(iinaPath)) player = iinaPath;
    } else if (player === 'vlc') {
      const vlcPaths = mac
        ? ['/Applications/VLC.app/Contents/MacOS/VLC']
        : ['C:\\Program Files\\VideoLAN\\VLC\\vlc.exe', 'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe'];
      const found = vlcPaths.find(p => existsSync(p));
      if (found) player = found;
    }
  }

  const o = (k, v) => `${mac ? '--mpv-' : '--'}${k}=${v}`;
  
  // Arguments are passed as an array (no shell) so stream data can't inject commands.
  const args = [
    ctx.chosen.url,
    o('user-agent', UA),
    o('referrer', REFERER),
    o('http-header-fields', `Origin: ${ORIGIN}`),
    o('ytdl', 'no'),
    o('force-media-title', ctx.title),
    ...ctx.subs.map((s) => o('sub-file', s.file)),
  ];
  console.log(`\n🎬 Launching ${player}...`);
  return new Promise((resolve, reject) => {
    const child = spawn(player, args, { stdio: 'ignore' });
    child.on('error', (e) =>
      reject(new Error(e.code === 'ENOENT' ? `${player} not found. Install it and make sure it is in your PATH.` : e.message))
    );
    child.on('close', () => resolve());
  });
}

// ---------- Download ----------
function buildName() {
  const ep = ctx.type === 'tv' ? ` S${pad(ctx.season)}E${pad(ctx.episode)}` : '';
  const raw = `${ctx.title}${ctx.year ? ` (${ctx.year})` : ''}${ep}`;
  const clean = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[. ]+$/, '')
    .slice(0, 150);
  return `${clean || 'video'}.mp4`;
}

// Returns the playlist text if the URL is an HLS playlist, otherwise null (without downloading the file).
async function sniffPlaylist(url) {
  const res = await http(url, { headers: API_HEADERS });
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!chunks.length && Buffer.from(value.subarray(0, 7)).toString() !== '#EXTM3U') {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
    size += value.length;
    if (size > 5_000_000) {
      await reader.cancel();
      return null;
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), base: res.url };
}

function parseAttrs(s) {
  const out = {};
  for (const m of s.matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g)) out[m[1]] = m[3] ?? m[2];
  return out;
}

function pickVariant(text, base) {
  let best = null;
  let bw = -1;
  let pending = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-STREAM-INF:')) pending = parseInt(parseAttrs(line.slice(18)).BANDWIDTH, 10) || 0;
    else if (line && !line.startsWith('#') && pending !== null) {
      if (pending > bw) { bw = pending; best = new URL(line, base).href; }
      pending = null;
    }
  }
  if (!best) throw new Error('no variants in master playlist');
  return best;
}

function parseMedia(text, base) {
  const segments = [];
  let seq = 0, key = null, init = null, dur = null, duration = 0, ended = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = parseInt(line.slice(22), 10) || 0;
    else if (line.startsWith('#EXT-X-BYTERANGE')) throw new Error('byte-range playlists are not supported');
    else if (line.startsWith('#EXT-X-KEY:')) {
      const at = parseAttrs(line.slice(11));
      if (at.METHOD === 'NONE') key = null;
      else if (at.METHOD === 'AES-128' && at.URI) key = { uri: new URL(at.URI, base).href, iv: at.IV || null };
      else throw new Error(`unsupported encryption (${at.METHOD})`);
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const at = parseAttrs(line.slice(11));
      if (at.URI) init = new URL(at.URI, base).href;
    } else if (line.startsWith('#EXTINF:')) dur = parseFloat(line.slice(8)) || 0;
    else if (line.startsWith('#EXT-X-ENDLIST')) ended = true;
    else if (!line.startsWith('#')) {
      segments.push({ url: new URL(line, base).href, seq: seq + segments.length, key });
      duration += dur || 0;
      dur = null;
    }
  }
  if (!segments.length) throw new Error('playlist has no segments');
  if (!ended) throw new Error('live or incomplete playlist');
  const urls = [...segments.map((s) => s.url), ...segments.filter((s) => s.key).map((s) => s.key.uri), init].filter(Boolean);
  if (!urls.every(isHttpUrl)) throw new Error('playlist references a non-HTTP URL');
  return { segments, init, duration };
}

// Some hosts disguise TS segments with junk before the data; find the first valid MPEG-TS sync pattern.
function stripToTsSync(buf) {
  if (buf[0] === 0x47) return buf;
  const limit = Math.min(buf.length - 376, 4096);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0x47 && buf[i + 188] === 0x47 && buf[i + 376] === 0x47) return buf.subarray(i);
  }
  return buf;
}

// Parallel HLS download into one local file; throws if the playlist uses features we don't handle
// (the caller then falls back to ffmpeg).
async function downloadHls({ text, base }) {
  if (text.includes('#EXT-X-STREAM-INF')) {
    const hasSeparateTracks = text.split(/\r?\n/).some(
      (l) => l.startsWith('#EXT-X-MEDIA:') && /TYPE=(AUDIO|SUBTITLES)/.test(l) && /URI=/.test(l)
    );
    if (hasSeparateTracks) throw new Error('separate audio tracks');
    const res = await http(pickVariant(text, base), { headers: API_HEADERS });
    text = await res.text();
    base = res.url;
  }

  const { segments, init, duration } = parseMedia(text, base);
  const total = segments.length;
  const file = join(getTmp(), `merged-${Date.now()}.${init ? 'mp4' : 'ts'}`);
  const fh = await open(file, 'w');

  const keyCache = new Map();
  const getKey = (uri) => {
    if (!keyCache.has(uri)) {
      keyCache.set(uri, http(uri, { headers: API_HEADERS }).then(async (r) => {
        const k = Buffer.from(await r.arrayBuffer());
        if (k.length !== 16) throw new Error('invalid AES key');
        return k;
      }));
    }
    return keyCache.get(uri);
  };

  const fetchSegment = async (seg) => {
    const res = await http(seg.url, { headers: API_HEADERS, retries: 4, timeout: 30000 });
    let buf = Buffer.from(await res.arrayBuffer());
    if (seg.key) {
      const iv = seg.key.iv
        ? Buffer.from(seg.key.iv.replace(/^0x/i, '').padStart(32, '0'), 'hex')
        : (() => { const b = Buffer.alloc(16); b.writeUInt32BE(seg.seq >>> 0, 12); return b; })();
      const d = createDecipheriv('aes-128-cbc', await getKey(seg.key.uri), iv);
      buf = Buffer.concat([d.update(buf), d.final()]);
    }
    return init ? buf : stripToTsSync(buf);
  };

  try {
    if (init) await fh.write(Buffer.from(await (await http(init, { headers: API_HEADERS })).arrayBuffer()));

    const ready = new Map();
    let nextIdx = 0, nextWrite = 0, bytes = 0, done = 0, failed = null, flushing = false;
    const t0 = Date.now();

    const flush = async () => {
      if (flushing) return;
      flushing = true;
      try {
        while (ready.has(nextWrite)) {
          const b = ready.get(nextWrite);
          ready.delete(nextWrite);
          await fh.write(b);
          nextWrite++;
        }
      } finally {
        flushing = false;
      }
    };

    const worker = async () => {
      while (!failed) {
        const idx = nextIdx++;
        if (idx >= total) return;
        while (idx - nextWrite >= SEGMENT_WINDOW && !failed) await sleep(30); // keep memory bounded
        if (failed) return;
        try {
          const buf = await fetchSegment(segments[idx]);
          ready.set(idx, buf);
          bytes += buf.length;
          done++;
          await flush();
        } catch (e) {
          failed = e;
        }
      }
    };

    const timer = setInterval(() => {
      const elapsed = (Date.now() - t0) / 1000 || 1;
      const pct = (done / total) * 100;
      const eta = done ? ` | ETA ${fmtTime((total - done) / (done / elapsed))}` : '';
      status(`${bar(pct)} ${pct.toFixed(1)}% | ${done}/${total} segments | ${fmtBytes(bytes)} | ${(bytes / 1048576 / elapsed).toFixed(1)} MB/s${eta}`);
    }, 250);

    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
    } finally {
      clearInterval(timer);
      clearStatus();
    }
    if (failed) throw failed;
    await flush();
    return { file, duration };
  } finally {
    await fh.close();
  }
}

function buildFfmpegArgs(source, outFile) {
  const a = ['-hide_banner', '-nostdin', '-nostats', '-y', '-progress', 'pipe:1'];
  if (source.file) a.push('-i', source.file);
  else {
    a.push(
      // Remote playlists must not be able to make ffmpeg read local files.
      '-protocol_whitelist', 'http,https,tcp,tls,crypto',
      '-user_agent', UA,
      '-headers', FFMPEG_HEADERS,
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', source.url
    );
  }
  ctx.subs.forEach((s) => a.push('-i', s.file));

  a.push('-map', '0:v:0', '-map', '0:a?');
  ctx.subs.forEach((_, i) => a.push('-map', `${i + 1}:s?`));

  if (opts.compress) a.push('-c:v', 'libx264', '-crf', '23', '-preset', 'fast', '-c:a', 'copy');
  else a.push('-c:v', 'copy', '-c:a', 'copy');

  if (ctx.subs.length) {
    a.push('-c:s', 'mov_text');
    ctx.subs.forEach((s, i) => a.push(`-metadata:s:s:${i}`, `title=${s.label}`));
  }
  a.push('-movflags', '+faststart', '-f', 'mp4', outFile);
  return a;
}

function runFfmpeg(args, knownTotal = null) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const forget = onCleanup(() => child.kill());
    let total = knownTotal, head = '', headDone = knownTotal !== null, errTail = '', outBuf = '';
    const prog = {};

    child.on('error', (e) => {
      forget();
      reject(new Error(`Could not start ffmpeg: ${e.message}`));
    });

    child.stderr.on('data', (d) => {
      const t = d.toString();
      errTail = (errTail + t).slice(-2000);
      if (!headDone) {
        head += t;
        const cut = head.indexOf('Input #1'); // only trust the duration of the main input
        const m = (cut >= 0 ? head.slice(0, cut) : head).match(/Duration:\s*(\d+:\d+:\d+\.\d+)/);
        if (m) { total = toSec(m[1]); headDone = true; }
        else if (cut >= 0) headDone = true;
      }
    });

    child.stdout.on('data', (d) => {
      outBuf += d.toString();
      const lines = outBuf.split(/\r?\n/);
      outBuf = lines.pop();
      for (const line of lines) {
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const k = line.slice(0, eq).trim();
        prog[k] = line.slice(eq + 1).trim();
        if (k === 'progress') renderFfmpeg(prog, total, prog.progress === 'end');
      }
    });

    child.on('close', (code) => {
      forget();
      clearStatus();
      resolve({ code, errTail });
    });
  });
}

function renderFfmpeg(p, total, done) {
  let cur = parseInt(p.out_time_us, 10) / 1e6;
  if (!(cur >= 0)) cur = 0;
  const size = parseInt(p.total_size, 10);
  const sizeStr = Number.isNaN(size) ? '-- MB' : fmtBytes(size);
  const speedNum = parseFloat(p.speed);
  const speed = Number.isNaN(speedNum) ? '--' : `${speedNum.toFixed(2)}x`;
  if (total) {
    const pct = done ? 100 : Math.min(100, (cur / total) * 100);
    const eta = !done && speedNum > 0 ? ` | ETA ${fmtTime((total - cur) / speedNum)}` : '';
    status(`${bar(pct)} ${pct.toFixed(1)}% | ${fmtTime(cur)}/${fmtTime(total)} | ${sizeStr} | ${speed}${eta}`);
  } else {
    status(`${fmtTime(cur)} | ${sizeStr} | ${speed}`);
  }
}

async function download() {
  if (!hasBin('ffmpeg')) throw new Error('ffmpeg not found. Install it and make sure it is in your PATH.');

  const outName = buildName();
  const outPath = join(process.cwd(), outName);
  if (existsSync(outPath)) {
    const a = await ask(`⚠️  ${outName} already exists. Overwrite? (y/N)`, { back: false });
    if (a === EXIT) process.exit(0);
    if (a.toLowerCase() !== 'y') return console.log('Skipped.');
  }

  console.log(`\n⬇️  Target: ${outName}`);
  console.log(opts.compress ? '🗜️  Compression enabled...' : '⚡ Direct copy...');

  // Write to a .part file and rename on success so a cancelled run never leaves a broken .mp4.
  const partPath = `${outPath}.part`;
  const forget = onCleanup(() => rmSync(partPath, { force: true }));
  let merged = null;
  try {
    let source = { url: ctx.chosen.url };
    let totalSec = null;

    const playlist = await sniffPlaylist(ctx.chosen.url).catch(() => null);
    if (playlist) {
      try {
        console.log(`🚀 Fast mode: downloading ${CONCURRENCY} segments in parallel...`);
        merged = await downloadHls(playlist);
        source = { file: merged.file };
        totalSec = merged.duration;
        console.log('🔧 Finalizing...');
      } catch (e) {
        console.log(`⚠️  Fast mode unavailable (${e.message}). Falling back to ffmpeg...`);
      }
    }

    const { code, errTail } = await runFfmpeg(buildFfmpegArgs(source, partPath), totalSec);
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}\n${errTail}`);

    renameSync(partPath, outPath);
    console.log(`✅ Download finished! Saved as: ${outName}`);
  } finally {
    rmSync(partPath, { force: true });
    if (merged) rmSync(merged.file, { force: true });
    forget();
  }
}

// ---------- Steps ----------
async function stepTitle(backing) {
  if (!backing && preset.query) {
    ctx.query = preset.query;
    preset.query = null;
    return NEXT;
  }
  for (;;) {
    const a = await ask('🔍 Search for a movie or TV show', { back: false });
    if (a === EXIT) return EXIT;
    if (a) { ctx.query = a; return NEXT; }
  }
}

async function stepResult() {
  console.log(`\n🔍 Searching TMDB for "${ctx.query}"...`);
  const results = await searchTitle(ctx.query);
  if (!results.length) {
    console.log('⚠️  No results found. Try a different title.');
    return BACK;
  }

  let pick = results[0];
  if (results.length > 1) {
    console.log('\nMultiple results found:');
    results.forEach((r, i) => {
      const y = (r.release_date || r.first_air_date || '').slice(0, 4) || 'Unknown';
      console.log(`  [${i + 1}] ${r.media_type === 'movie' ? '🎬 Movie' : '📺 TV Show'} | ${r.title || r.name} (${y})`);
    });
    for (;;) {
      const a = await ask('👉 Select a number (Enter = 1)');
      if (a === EXIT || a === BACK) return a;
      const n = a === '' ? 1 : parseInt(a, 10);
      if (n >= 1 && n <= results.length) { pick = results[n - 1]; break; }
      console.log('⚠️  Invalid selection.');
    }
  }

  Object.assign(ctx, {
    id: pick.id,
    type: pick.media_type,
    title: pick.title || pick.name,
    year: (pick.release_date || pick.first_air_date || '').slice(0, 4),
    seasons: undefined,
    season: null,
    episode: null,
  });
  console.log(`✅ Selected: ${ctx.title}${ctx.year ? ` (${ctx.year})` : ''} [${ctx.type}]`);
  return results.length === 1 ? AUTO : NEXT;
}

async function stepEpisode(backing) {
  if (ctx.type !== 'tv') return AUTO;
  if (ctx.seasons === undefined) ctx.seasons = await loadSeasons(ctx.id);
  const seasons = ctx.seasons;
  const info = (n) => seasons?.find((x) => x.number === n);

  let s = null, e = null;
  if (!backing) {
    s = preset.season;
    e = preset.episode;
    preset.season = preset.episode = null;
  }

  for (;;) {
    if (s !== null && seasons && !info(s)) {
      console.log(`⚠️  Season ${s} doesn't exist for this show.`);
      s = e = null;
    }
    if (s === null) {
      const range = seasons ? ` [${seasons[0].number}-${seasons.at(-1).number}]` : '';
      const a = await ask(`📺 Season${range}`);
      if (a === EXIT || a === BACK) return a;
      s = toInt(a);
      if (s === null) console.log('⚠️  Enter a number.');
      continue;
    }
    const count = info(s)?.count;
    if (e !== null && (e < 1 || (count && e > count))) {
      console.log(`⚠️  Episode ${e} doesn't exist in season ${s}.`);
      e = null;
    }
    if (e === null) {
      const a = await ask(`📺 Episode${count ? ` [1-${count}]` : ''}`);
      if (a === EXIT) return a;
      if (a === BACK) { s = null; continue; }
      e = toInt(a);
      if (e === null) console.log('⚠️  Enter a number.');
      continue;
    }
    break;
  }

  ctx.season = s;
  ctx.episode = e;
  console.log(`📺 Target: Season ${s}, Episode ${e}`);
  return NEXT;
}

async function stepSources() {
  const key = `${ctx.id}:${ctx.season}:${ctx.episode}`;
  if (ctx.streamKey === key) return AUTO;
  console.log('📡 Scanning servers...');
  const found = await findStreams();
  if (!found) throw new Error('No working streams found.');
  ctx.sources = found.sources
    .map((s) => ({ quality: String(s.quality ?? 'Unknown'), url: s.url }))
    .sort((a, b) => qualityValue(b.quality) - qualityValue(a.quality));
  ctx.nativeSub = found.sub || null;
  ctx.streamKey = key;
  console.log(`🎉 Stream found on: ${found.server.toUpperCase()}`);
  return AUTO;
}

async function stepQuality(backing) {
  const list = ctx.sources;
  if (list.length === 1) {
    ctx.chosen = list[0];
    return AUTO;
  }
  if (!backing && preset.quality) {
    const m = matchQuality(list, preset.quality);
    if (m) {
      ctx.chosen = m;
      console.log(`📊 Quality: ${m.quality}`);
      return NEXT;
    }
    console.log(`⚠️  Quality "${preset.quality}" is not available.`);
  }
  console.log('\n📊 Available qualities:');
  list.forEach((q, i) => console.log(`  [${i + 1}] ${q.quality}`));
  for (;;) {
    const a = await ask('👉 Select quality');
    if (a === EXIT || a === BACK) return a;
    const n = parseInt(a, 10);
    if (n >= 1 && n <= list.length) {
      ctx.chosen = list[n - 1];
      preset.quality = ctx.chosen.quality.toLowerCase(); // reuse for the next episode
      return NEXT;
    }
    console.log('⚠️  Invalid selection.');
  }
}

async function stepSubs() {
  if (!opts.subs) {
    ctx.subs = [];
    return AUTO;
  }
  const key = `${ctx.streamKey}:${opts.lang}`;
  if (ctx.subsKey === key) return AUTO;
  console.log('📝 Fetching subtitles...');
  ctx.subs = await fetchSubtitles();
  ctx.subsKey = key;
  console.log(ctx.subs.length ? `✅ Loaded ${ctx.subs.length} subtitle track(s).` : '⚠️  No subtitles found.');
  return AUTO;
}

async function stepAction() {
  try {
    if (ctx.command === 'watch') await watch();
    else await download();
  } catch (e) {
    console.error(`\n❌ ${e.message}`);
  }

  const next = nextEpisode();
  console.log('\nWhat next?');
  if (next) console.log(`  [n] Next episode (S${pad(next.season)}E${pad(next.episode)})`);
  console.log(`  [${ctx.command === 'watch' ? 'd' : 'w'}] ${ctx.command === 'watch' ? 'Download' : 'Watch'} this instead`);
  console.log('  [s] New search');
  for (;;) {
    const a = await ask('👉 Choose');
    if (a === EXIT || a === BACK) return a;
    const c = a.toLowerCase();
    if (c === 'n' && next) {
      ctx.season = next.season;
      ctx.episode = next.episode;
      console.log(`📺 Target: Season ${ctx.season}, Episode ${ctx.episode}`);
      return { goto: S.SOURCES };
    }
    if (c === 's') return { goto: S.TITLE, backing: true };
    if (c === 'w' || c === 'd') {
      ctx.command = c === 'w' ? 'watch' : 'download';
      return { goto: S.ACTION };
    }
    console.log('⚠️  Invalid choice.');
  }
}

// ---------- Main flow ----------
const S = { TITLE: 0, RESULT: 1, EPISODE: 2, SOURCES: 3, QUALITY: 4, SUBS: 5, ACTION: 6 };
const steps = [stepTitle, stepResult, stepEpisode, stepSources, stepQuality, stepSubs, stepAction];

if (!ctx.command) {
  for (;;) {
    const a = await ask('🎛️  [1] Watch  [2] Download', { back: false });
    if (a === EXIT) process.exit(0);
    if (['1', 'w', 'watch'].includes(a.toLowerCase())) { ctx.command = 'watch'; break; }
    if (['2', 'd', 'download'].includes(a.toLowerCase())) { ctx.command = 'download'; break; }
  }
}

const auto = new Array(steps.length).fill(false);
let i = 0;
let backing = false;

while (i < steps.length) {
  let r;
  try {
    r = await steps[i](backing);
  } catch (e) {
    console.error(`\n❌ ${e.message}`);
    const a = await ask('Press Enter to retry', { back: i > 0 });
    if (a === EXIT) break;
    if (a !== BACK) continue;
    r = BACK;
  }

  if (r === EXIT) break;
  if (r === BACK) {
    i = Math.max(0, i - 1);
    while (i > 0 && auto[i]) i--; // skip steps that needed no input
    backing = true;
  } else if (r && typeof r === 'object') {
    i = r.goto;
    backing = !!r.backing;
  } else {
    auto[i] = r === AUTO;
    backing = false;
    i++;
  }
}

console.log('👋 Bye!');
process.exit(0);