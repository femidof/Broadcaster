# Broadcaster

A lightweight desktop multistream relay app. Stream to Twitch, YouTube, Facebook Live, Instagram Live, TikTok Live, Trovo, Kick, Restream, and custom RTMP destinations simultaneously from a single OBS connection.

Built with **Tauri v2** (Rust) + **React** + **Node.js sidecar**.

## How It Works

```
OBS → localhost:1935 → Broadcaster → Twitch
                                   → YouTube
                                   → Facebook Live
                                   → Instagram Live
                                   → TikTok Live
                                   → Trovo
                                   → Kick
                                   → Restream
                                   → Custom RTMP
```

1. Broadcaster runs a local RTMP server on port 1935
2. OBS connects once to `rtmp://localhost:1935/live`
3. Broadcaster relays the stream to all enabled destinations via a built-in RTMP relay client (no FFmpeg required for relaying)

## Prerequisites

- [Node.js](https://nodejs.org/) v20+
- [Rust](https://rustup.rs/) (latest stable)
- Platform build tools:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Windows**: Visual Studio Build Tools with C++ workload
  - **Linux**: `build-essential`, `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, `patchelf`

## Setup

```bash
# Install all dependencies, download ffmpeg, and build the sidecar
npm run setup
```

Or step by step:

```bash
npm install
cd sidecar && npm install && cd ..
npm run ffmpeg:download
npm run sidecar:build
```

## Development

```bash
npm run tauri dev
```

This starts the Vite dev server with HMR and launches the Tauri app in development mode.

## Building

```bash
npm run build:release
```

This single command ensures the sidecar and FFmpeg binaries are present (downloading/building them if needed), then produces the native installer. The resulting binary is fully self-contained and can be shared directly -- recipients do not need Node.js, Rust, or FFmpeg installed.

If you have already run `npm run setup`, you can also use `npm run tauri build` directly; it will verify binaries before building.

Outputs:
- **macOS**: `.dmg` in `src-tauri/target/release/bundle/dmg/`
- **Windows**: NSIS `.exe` in `src-tauri/target/release/bundle/nsis/`
- **Linux**: `.deb`, `.AppImage` in `src-tauri/target/release/bundle/`

## OBS Configuration

1. Open OBS → Settings → Stream
2. Set Service to **Custom**
3. Server: `rtmp://localhost:1935/live`
4. Stream Key: `stream` (or any non-empty key)
5. Click **Start Streaming**

Notes:
- Broadcaster starts relaying from the exact stream key OBS publishes (for example, `/live/stream` or `/live/myKey`).
- `Incoming connection` in Debug Output means a client connected to RTMP. Relays and stream status only switch to active after publish begins.

## Project Structure

```
├── src/                    # React frontend
│   ├── components/         # UI components (Dashboard, Destinations, Settings)
│   ├── lib/                # Types, Tauri IPC wrappers, utilities
│   └── App.tsx             # Main app with state management
├── src-tauri/              # Tauri/Rust backend
│   ├── src/
│   │   ├── lib.rs          # Tauri commands and setup
│   │   └── sidecar.rs      # Sidecar lifecycle management
│   ├── binaries/           # Compiled sidecar + ffmpeg binaries
│   └── tauri.conf.json     # Tauri configuration
├── sidecar/                # Node.js sidecar
│   ├── src/
│   │   ├── index.ts        # Entry point, stdin/stdout IPC
│   │   ├── rtmp-server.ts  # node-media-server wrapper
│   │   ├── relay-manager.ts# FFmpeg process manager
│   │   └── config-store.ts # JSON config persistence
│   └── build.mjs           # Build script (tsc + pkg)
└── scripts/
    ├── download-ffmpeg.mjs # FFmpeg binary downloader
    └── ensure-binaries.mjs # Pre-build check for required binaries
```

## Architecture

```
React Frontend ←→ Tauri Rust Core ←→ Node Sidecar (stdin/stdout JSON)
                                          ├── node-media-server (RTMP ingest)
                                          └── custom RTMP relay client (push to destinations)
```

- **Frontend**: React + Tailwind CSS, communicates with Rust via `invoke()`
- **Rust Core**: Manages sidecar lifecycle, relays events to frontend
- **Node Sidecar**: Compiled to standalone binary via `pkg`, handles RTMP ingest and relaying
- **Communication**: JSON lines over stdin/stdout between Rust and Node

Notes:
- FFmpeg is bundled for compatibility/tooling, but the current relay mechanism uses a custom RTMP client implementation.

## Debug Mode (Release Builds)

If the app isn't working as expected after install, enable **Debug Mode** to see diagnostic output:

1. Open the app and go to **Settings**
2. Toggle **Debug Mode** on
3. A **Debug Output** panel appears below the settings, showing:
   - Sidecar process stderr and startup errors
   - FFmpeg relay errors and output
   - RTMP server connection events
   - Abnormal sidecar termination details
4. The setting persists across restarts

This surfaces errors that would otherwise only appear in system logs, making it easy to diagnose issues like port conflicts, missing binaries, or FFmpeg failures without external tooling.

## Updater

To enable auto-updates from GitHub Releases:

1. Generate signing keys:
   ```bash
   npm run tauri signer generate -- -w ~/.tauri/broadcaster.key
   ```

2. Add the public key to `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`

3. Add your GitHub release endpoint to `plugins.updater.endpoints`

4. Set `TAURI_SIGNING_PRIVATE_KEY` when building releases

## License

MIT
