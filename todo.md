# TODO

## Broadcaster 3.0.0

- [ ] Migrate `node-media-server` from v2.7.4 to v4.
  - Treat this as a breaking integration change, not a dependency-only update.
  - Replace the private v2 AMF import used by the native RTMP relay.
  - Adapt publish/connect event handling to v4 session objects.
  - Rework per-profile server startup, shutdown, socket ownership, and shared global state.
  - Redirect or silence v4 logging so sidecar stdout remains newline-delimited JSON.
  - Review removed or changed RTMP options, stream-key restrictions, and codec compatibility.
  - Verify simultaneous profiles, OBS reconnects, fallback slate behavior, native and FFmpeg relays, and packaged builds on Windows, macOS, and Linux.

