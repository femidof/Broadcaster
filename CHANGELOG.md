# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-04-17

### Added

- **Per-destination FFmpeg relay mode**: Destinations can optionally be relayed via the bundled FFmpeg (with optional advanced args) instead of the native RTMP client.
- **Windows icon improvements**: Regenerated app icons, set the NSIS installer icon, and added installer hooks to refresh the Windows shell icon cache.

## [2.0.0] - 2026-04-05

### Added

- **Profiles**: Multiple named streaming profiles, each with its own RTMP ingest port, destinations, and optional auto-start. Profiles can run at the same time on different ports (e.g. backup or split distribution).
- **Default profile**: New and migrated configs always include at least one profile (`Default` on migration from v1).
- **GNU Affero General Public License v3.0** (AGPL-3.0-only) for the project; `LICENSE`, `CONTRIBUTING.md`, and this changelog.

### Changed

- **License**: Project license is now AGPL-3.0-only (previously MIT).
- **Auto-start**: Default for new profiles is **off**; the RTMP server does not start automatically until you enable auto-start for a profile or start it manually.
- **IPC**: Commands and sidecar events are scoped by `profileId` where relevant; `start_server` uses each profile’s configured port (no separate port argument).

### Migration

- Existing `config.json` from v1 (flat `port`, `autoStart`, `destinations`) is migrated into a single **Default** profile; global `debugMode` is preserved.

## [1.0.0] - 2026-04-05

### Added

- Initial public release: single local RTMP ingest, multistream relay to multiple destinations via the Node sidecar, Tauri v2 desktop shell, and React UI.
