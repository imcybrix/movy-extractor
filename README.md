# 🎬 Movy CLI

A fast, terminal-based movie and TV show streamer and downloader.

Search a title, pick a quality, then either watch it in your player or download it as an MP4, all from an interactive menu. Downloads fetch HLS segments in parallel, and subtitles are picked up automatically.

## ✨ Features

- 🚀 **Parallel downloads:** a built-in HLS downloader fetches 16 segments at once and decrypts AES-128 streams. It falls back to plain ffmpeg for anything it can't handle (separate audio tracks, live or byte-range playlists, other encryption).
- ⚡ **Fast stream lookup:** all servers are probed at the same time and the first working one wins.
- 🎮 **Binge-friendly:** when a player closes or a download finishes, a menu lets you jump to the next episode (rolling into the next season), switch between watch and download, or start a new search.
- ⬅️ **Back and exit anywhere:** type `b` to go back one step or `x` to exit at any prompt. Ctrl+C also exits cleanly without leaving half-finished files.
- 📝 **Multiple subtitle tracks:** uses the stream's own subtitle when available and can add more through [Wyzie Subs](https://sub.wyzie.io), up to 3 tracks, which are embedded in downloaded MP4s.
- 🖥️ **Sensible player defaults:** mpv.net on Windows, IINA on macOS, mpv on Linux, each with a fallback to plain mpv.
- 🔒 **Safer by design:** the player is launched without a shell, ffmpeg is restricted to http(s) so a playlist can't read local files, and API keys live in `.env`.

## 🛠️ Prerequisites

| Requirement | Needed for | Notes |
|---|---|---|
| [Node.js](https://nodejs.org) 20+ | Everything | |
| [FFmpeg](https://ffmpeg.org) | Downloading | Must be in your `PATH` |
| A player | Watching | mpv.net / mpv (Windows), IINA (macOS), mpv (Linux) |
| [TMDB API key](https://www.themoviedb.org/settings/api) | Everything | Free |
| Wyzie Subs API key | Extra subtitles | Optional, free tier available |

### Quick install

**macOS** (Homebrew):

```bash
brew install node ffmpeg
brew install --cask iina
```

**Windows** (winget):

```powershell
winget install OpenJS.NodeJS
winget install Gyan.FFmpeg
```

Then install [mpv.net](https://github.com/mpvnet-player/mpv.net) from its releases page (or plain mpv), and make sure `mpvnet` / `mpv` can be run from a terminal.

**Linux** (Debian/Ubuntu):

```bash
sudo apt update && sudo apt install nodejs ffmpeg mpv
```

## ⚙️ Setup

1. Put `cli.js` in a folder and open a terminal there.
2. The script uses ES modules, so mark the folder as an ES-module project (skip this if you already have a `package.json` with `"type": "module"`):

   ```bash
   npm init -y
   npm pkg set type=module
   ```

3. Optional but recommended: install `dotenv` so the script can read a `.env` file.

   ```bash
   npm install dotenv
   ```

4. Create a `.env` file next to `cli.js`:

   ```env
   TMDB_KEY=your_tmdb_api_key_here
   WYZIE_KEY=your_wyzie_api_key_here
   ```

   `WYZIE_KEY` is optional. Without it you only get the stream's own subtitle, if it has one. If you'd rather not use `dotenv`, set the same variables in your environment instead.

> Keep `.env` out of version control. If you use git, add it to `.gitignore`.

## 🚀 Usage

### Interactive mode (recommended)

```bash
node cli.js
```

You'll be guided through: **Watch / Download → Search → Pick result → Season & episode → Quality**.

### Direct mode

Pass arguments to skip the menus:

```bash
# Watch a movie in 1080p
node cli.js watch "Inception" -q 1080

# Download a TV episode, re-encoded to a smaller file
node cli.js download "Breaking Bad" -s 1 -e 1 -q 720 --compress

# Watch without subtitles
node cli.js watch "Dune" --no-subs
```

Anything you leave out is asked for interactively.

### Flags

| Flag | Description | Example |
|---|---|---|
| `-s <n>` | Season number (TV shows) | `-s 2` |
| `-e <n>` | Episode number (TV shows) | `-e 4` |
| `-q <quality>` | `1080`, `720`, `4k`, `best` or `worst` | `-q 1080` |
| `-l <lang>` | Language for extra subtitles (default `en`) | `-l es`, `-l pt-BR` |
| `--compress` | Re-encode to smaller H.264 (download only, slower) | `--compress` |
| `--no-subs` | Skip subtitles entirely | `--no-subs` |
| `-h`, `--help` | Show help | `-h` |

### Navigation

| Key | Action |
|---|---|
| `b` | Go back one step |
| `x` | Exit |
| `Enter` | Accept the default (e.g. first search result) |
| `Ctrl+C` | Cancel immediately; partial downloads and temp files are cleaned up |

After each watch or download you get a short menu:

- `n`: next episode (TV shows)
- `w` / `d`: switch to watching or downloading the same thing
- `s`: new search
- `b` / `x`: go back or exit

## 📦 Downloads

- Files are saved in the folder you run the command from, named like `Show_Name_(2021)_S01E02.mp4`.
- Files are written as `.part` and renamed when finished, so a cancelled download never leaves a broken `.mp4`.
- If the file already exists, you're asked before it's overwritten.
- In fast mode the segments are merged into a temporary file first, so you need roughly the video's size in free disk space during the download.
- Without `--compress` the video is copied as-is (fastest). With it, the video is re-encoded to H.264 and the speed depends on your CPU.

## 💡 Tips

- **Custom player:** set `PLAYER` to any mpv-compatible command.

  ```bash
  PLAYER="mpv" node cli.js watch "Dune"          # macOS/Linux
  $env:PLAYER="mpv"; node cli.js watch "Dune"    # Windows PowerShell
  ```

- **Switching subtitle tracks:** in mpv and mpv.net, press `j` to cycle through loaded subtitle tracks and `v` to turn subtitles on or off. In IINA, use the Subtitles menu.
- **Quality carries over:** the quality you pick is reused for the next episode.
- **Check your tools:** run `ffmpeg -version` and `mpv --version` (or `mpvnet --version`) to confirm they're on your `PATH`.

## 🐛 Troubleshooting

| Problem | Cause and fix |
|---|---|
| `TMDB_KEY is not set` | Create the `.env` file (and install `dotenv`), or set the variable in your environment. |
| `TMDB rejected the API key` | The key is wrong. Re-copy it from your TMDB account settings. |
| `Cannot use import statement` / `Unexpected token 'export'` | The folder isn't an ES-module project. Run `npm pkg set type=module` (see Setup). |
| `ffmpeg not found` | FFmpeg isn't installed or isn't on your `PATH`. |
| `No video player found` | Install mpv.net / mpv (Windows), IINA (macOS) or mpv (Linux), or set `PLAYER`. |
| `No working streams found` | The title may not be available, or the upstream servers are down or rate-limited. Try again later or pick another result. |
| `Fast mode unavailable (…)` | Not an error: the stream uses a feature the fast downloader skips, so ffmpeg is used instead. It works, just slower. |
| Download fails with `403` | The stream link may have expired. Re-run to fetch a fresh one. |
| No subtitles | Not every title has them. Add a `WYZIE_KEY`, or try another language with `-l`. |

## ⚠️ Notes

- This tool relies on unofficial third-party endpoints. They can change or stop working at any time, and if streams suddenly stop being found, that is the most likely reason.
- You are responsible for how you use it. Only access content you have the right to, and follow the laws and terms that apply to you.
- This project is not affiliated with TMDB, Wyzie Subs or any streaming site. Movie and show metadata comes from [TMDB](https://www.themoviedb.org).
