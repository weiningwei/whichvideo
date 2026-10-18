# CLAUDE.md

Authoritative developer guidance lives in [`AGENTS.md`](./AGENTS.md). Read it before changing code.

WhichVideo is a Tauri 2 desktop application with a Rust backend and a React 19/Tailwind v4
renderer. Run all project commands from the repository root. The normal validation sequence is:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Backend code lives in `src-tauri/src`, the renderer in `src/renderer/src`, and cross-boundary
TypeScript contracts in `src/shared`. Keep the frontend bridge, Rust command implementations and
Tauri registration list synchronized; `pnpm test:contract` enforces that boundary.
