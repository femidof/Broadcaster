# Contributing to Broadcaster

Thank you for your interest in contributing. This document describes how to work on the project effectively.

## Development setup

Follow the [README](README.md) **Setup** and **Development** sections:

```bash
npm run setup
npm run tauri dev
```

The app uses a three-process model: **React** (UI) ↔ **Tauri Rust** ↔ **Node sidecar** (JSON lines over stdin/stdout). When you change behavior that crosses these boundaries, update types and commands in all affected layers (see below).

## Pull requests

- Open PRs against the default branch; use a short, descriptive title.
- Describe **what** changed and **why** in the PR body.
- Keep changes focused; unrelated refactors make review harder.

## Code style

- **TypeScript / React**: run `npm run lint` from the repo root before pushing.
- **Rust**: run `cargo clippy --manifest-path src-tauri/Cargo.toml` and fix new warnings you introduce.

## Architecture and type sync

Shared concepts (`Destination`, `RelayStatus`, profile types, IPC commands/events) must stay aligned across:

- `src/lib/types.ts` (frontend)
- `sidecar/src/types.ts` (sidecar)
- `src-tauri/src/sidecar.rs` and `src-tauri/src/lib.rs` (Rust commands), where applicable

If you add or rename an IPC field, update every consumer and document the change in [CHANGELOG.md](CHANGELOG.md) when the change is user-visible.

## Testing

There is no automated test suite requirement today. Manually verify flows you touch (e.g. start/stop server, add destination, push) in `npm run tauri dev`. Note any gaps in your PR if full verification is not possible.

## Code of Conduct

Be respectful and constructive. Report unacceptable behavior to the maintainers of this repository.

## License

By contributing, you agree that your contributions will be licensed under the same terms as the project (GNU Affero General Public License v3.0 only). See [LICENSE](LICENSE).
