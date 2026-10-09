# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Authoritative developer guidance lives in [`AGENTS.md`](./AGENTS.md)** (auto-loaded alongside this file). It contains the full command reference, architecture, hard constraints, and the 21-suite test matrix. This file intentionally does not duplicate it — read `AGENTS.md` before making changes.

## Cold start

- **Electron + electron-vite + React 19 + Tailwind v4** local video library ("以图搜帧" — search video frames by image). Package manager **pnpm**, Node ≥ 22.
- **Run every `pnpm` script from the repo root.** `electron.vite.config.ts` resolves paths via `process.cwd()` and validates `src/main/index.ts` exists — changing directory makes it throw.
- Main process builds to **CommonJS** (`out/main/index.js`); renderer is ESM/React. `package.json` must **not** carry `"type": "module"`.
- Common scripts: `pnpm dev`, `pnpm typecheck`, `pnpm test`, `pnpm build`. Run one suite via `pnpm test:<suite>` (e.g. `pnpm test:config`).

## Where things live

- `src/main/` — main process: `index.ts` (bootstrap/window/datadir/lifecycle), `ipc.ts` (26 IPC handlers, deps injected via `IpcDeps`), `db.ts` (SQLite), `search.ts` (in-memory frame index + scoring), `indexer.ts` (frame extraction queue), `watcher.ts` (chokidar), `media.ts` (ffmpeg/ffprobe), `scan.ts`, `datadir.ts`, `logger.ts`, `constants.ts`, `interfaces.ts`.
- `src/shared/` — code shared across main/preload/renderer (`types.ts` with IPC channels, `hash.ts`, `framepack.ts`). Note: aliases must be declared **per-segment**.
- `src/renderer/src/` — React UI (`LibraryView.tsx`, `VideoRow.tsx`, `useVideoCursor.ts`, `lib/selection.ts`).
- `docs/` — `how-search-works.md` (retrieval internals), `troubleshooting.md` (packaging/startup); `README.md` is user-facing.
