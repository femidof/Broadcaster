# AGENTS.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

Broadcaster is a desktop multistream relay app built with **Tauri v2** (Rust) + **React 19** + a **Node.js sidecar** compiled to a standalone binary via `pkg`. **v2** supports **multiple profiles**: each profile has its own local RTMP ingest port, destination list, and optional auto-start. OBS (or another encoder) connects to `rtmp://localhost:<port>/live` for the active profile’s port; the sidecar relays to that profile’s destinations using a native RTMP client implementation (not FFmpeg for relaying — FFmpeg is bundled but the relay uses a custom `RtmpClient` in `sidecar/src/rtmp-relay.ts`).

The project is licensed under **GNU AGPL v3.0 only**; see the root `LICENSE` file.

## Commands

### Setup (first time)
```
npm run setup
```
This installs dependencies (root + sidecar), downloads FFmpeg, and builds the sidecar binary.

### Development
```
npm run tauri dev
```
Starts Vite dev server (port 1420) with HMR and launches the Tauri app. The Rust backend auto-starts the sidecar process.

### Build for release
```
npm run build:release
```
Ensures binaries exist (auto-downloads/builds if missing), then runs `tauri build`.

### Lint (frontend only)
```
npm run lint
```
Runs ESLint on TypeScript/TSX files (see `eslint.config.js` for ignores).

### Sidecar-only rebuild
```
npm run sidecar:build      # Full build: tsc + pkg → binary in src-tauri/binaries/
npm run sidecar:dev        # TypeScript compile only (no pkg)
```

### Rust backend
```
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml
```

## Architecture

### Three-process model
```
React Frontend  ←invoke()→  Tauri Rust Core  ←stdin/stdout JSON lines→  Node Sidecar
```

1. **React Frontend** (`src/`): Single-page app using React 19 + Tailwind CSS v4. State lives primarily in `App.tsx` (multi-profile selection, per-profile dashboard/destinations/settings). Communicates with Rust via `@tauri-apps/api` `invoke()` calls. IPC wrappers are in `src/lib/tauri.ts`, shared types in `src/lib/types.ts`. Path alias `@/` maps to `src/`.

2. **Tauri Rust Core** (`src-tauri/src/`): Thin orchestration layer. `lib.rs` defines Tauri commands that serialize JSON and forward to the sidecar via stdin (commands include `profileId` where relevant). `sidecar.rs` manages the sidecar lifecycle (spawn, stdin write, stdout/stderr event parsing, graceful shutdown + force kill). Events from the sidecar are emitted to the frontend via the `sidecar-event` Tauri channel as JSON (including `all_servers_stopped` when the sidecar process exits).

3. **Node Sidecar** (`sidecar/`): Compiled to a standalone binary via `@yao-pkg/pkg` (no Node.js runtime needed at runtime). Reads JSON commands from stdin, emits JSON events to stdout. Contains:
   - `index.ts` — Entry point, stdin command dispatcher; one `RelayManager` + optional `RtmpServer` per profile (`Map` by profile id)
   - `rtmp-server.ts` — Wraps `node-media-server` for local RTMP ingest
   - `relay-manager.ts` — Manages relay lifecycle per destination with exponential backoff retry (max 5 retries)
   - `rtmp-relay.ts` — Custom RTMP client (`RtmpClient`) that implements the full RTMP handshake and protocol; `DirectRelay` pulls from local RTMP and pushes to remote RTMP/RTMPS. This is the actual relay mechanism, not FFmpeg.
   - `config-store.ts` — JSON file persistence in the app data directory (`debugMode` + `profiles[]`; each profile owns `port`, `autoStart`, `destinations`). Migrates legacy flat v1 `config.json` into a single **Default** profile.
   - `types.ts` — Shared types for `InboundCommand`, `OutboundEvent`, `Profile`, `ProfileStatus`, etc.

### IPC protocol
Rust ↔ Sidecar communication uses newline-delimited JSON over stdin (commands) and stdout (events). Commands are **profile-scoped** where appropriate (`start_server`, `add_destination`, etc. include `profileId`). Types are defined in `sidecar/src/types.ts` (Node) and must stay aligned with `src/lib/types.ts` (frontend). Rust command args use `serde` structs in `src-tauri/src/lib.rs` / `sidecar.rs` (`Destination`, `Profile`).

### Binary bundling
Tauri bundles two external binaries from `src-tauri/binaries/`:
- `broadcaster-sidecar-{target-triple}` — the compiled sidecar
- `ffmpeg-{target-triple}` — static FFmpeg binary

The `scripts/ensure-binaries.mjs` pre-build hook auto-downloads/builds any missing binaries. Target triples are resolved via `rustc --print host-tuple`.

### Type duplication
`Destination`, `RelayStatus`, `Profile`, profile-scoped events, and related shapes are defined in:
- `src/lib/types.ts` (frontend)
- `sidecar/src/types.ts` (sidecar)
- `src-tauri/src/sidecar.rs` (Rust: `Destination`, `Profile`, etc. for commands)

Keep these in sync when changing IPC.

### CI/Release
`.github/workflows/release.yml` builds for macOS (ARM + x86), Windows, and Linux on tag push (`v*`). Uses `tauri-apps/tauri-action` and creates a draft GitHub release.
