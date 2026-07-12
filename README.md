<div align="center">
  <table>
    <tr>
      <td valign="middle"><img src="./src-tauri/icons/128x128.png" alt="" width="56" height="56" /></td>
      <td valign="middle"><h1>Broadcaster</h1></td>
    </tr>
  </table>
</div>

**Current version:** **2.2.1**

A lightweight desktop multistream relay app. Stream to Twitch, YouTube, Facebook Live, Instagram Live, TikTok Live, Trovo, Kick, Restream, BIGO LIVE, and custom RTMP destinations simultaneously. **Version 2** adds **profiles**: multiple named setups, each with its own local RTMP port and destination list, so you can run several ingest servers at once (for example backup or split distribution).

Built with **Tauri v2** (Rust) + **React** + **Node.js sidecar**.

**Why this stack?** [Overview of the framework and technology choices](https://claude.ai/share/7fb1e97b-d256-4aed-83a1-bfcf52cab5d2).

## How It Works

```
OBS → localhost:<port> (per profile) → Broadcaster → Twitch / YouTube / …
```

1. Pick a **profile** (each profile has its own RTMP port, default **1935** for the first profile).
2. Start that profile’s RTMP server (or enable **auto-start** for it in Settings).
3. Point OBS at `rtmp://localhost:<port>/live` with your chosen stream key.
4. Broadcaster relays to all **enabled destinations on that profile** via a built-in RTMP relay client (no FFmpeg required for relaying).

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

1. Select the profile you want in the app (each profile has its own port; check **Settings** for the current port).
2. Open OBS → Settings → Stream
3. Set Service to **Custom**
4. Server: `rtmp://localhost:<profile-port>/live`
5. Stream Key: `stream` (or any non-empty key)
6. Click **Start Streaming**

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
│   │   ├── relay-manager.ts    # Per-profile RTMP relay lifecycle
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

## Troubleshooting

### Windows shortcut still shows the old / generic icon

Windows caches shortcut and Start Menu icons per install path. If you installed a previous build, Explorer may keep showing the stale icon even after reinstalling. The installer now asks Explorer to refresh automatically, but if the icon is still wrong, run this from `cmd` and then close/reopen Explorer windows:

```cmd
ie4uinit.exe -show
```

If that does not help, sign out and back in (or reboot). As a last resort you can delete the icon cache database at `%LocalAppData%\IconCache.db` and restart `explorer.exe`.

## Updater

The app can check for updates when Tauri’s updater is configured (public key, endpoints, and signed release artifacts). That setup is optional for local builds and is documented for **maintainers only** in `RELEASE_SIGNING.local.md`, which is gitignored and not part of the published repository—copy or recreate that file on machines used for releases.

## Feature flags (build-time)

Broadcaster supports build-time feature flags via Vite env variables. These are **compiled into the frontend at build time** and default to **OFF** unless explicitly enabled.

- `VITE_FEATURE_RELIABILITY_SUITE=1`: Enables Reliability Suite UI (Connection Doctor + error-to-fix actions)
- `VITE_FEATURE_ANALYTICS=1`: Enables Analytics UI (bitrate sparklines + session summary)

Example:

```bash
VITE_FEATURE_RELIABILITY_SUITE=1 VITE_FEATURE_ANALYTICS=1 npm run build:release
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes are tracked in [CHANGELOG.md](CHANGELOG.md).

## License

[GNU Affero General Public License v3.0 only](LICENSE) (AGPL-3.0-only).
