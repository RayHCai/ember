# 0009: Monorepo audit

**Status:** in-progress
**Touches:** repo root, .github/, docker/, internal/, services/\*, apps/\*, tools/\*, docs/

## Goal

Every package sits where the docs say, is held to the one gate, and ships through a CI/CD pipeline
that runs on the real default branch and builds what it releases.

## Plan

- [x] Finish `apps/sim` -> `apps/drone-sim`
- [x] `services/demo-data` into the uv workspace and turbo gate; module `demo_data` -> `ember_demo_data`
- [x] `tools/demo-data` stub (same project name as the real one) -> `tools/seed-data`
- [x] `internal/` as workspace package `@ember/go-internal`, so turbo hashes it into the Go services
      and runs its tests
- [x] turbo: build inputs `$TURBO_DEFAULT$` (Go source dirs were missed); `go.sum`, `uv.lock` global
- [x] CI and release on `master`; actions SHA-pinned; Rust in lint/format; images built in CI
- [x] `docker/{node,go,python}.Dockerfile` and `.github/workflows/images.yml`
- [x] Per-language fixes: Python (demo-data to ruff + mypy strict), TS (dev/start scripts, shutdown),
      Go (`internal/edgehttp`, server/client timeouts), Rust (clippy clean)
- [x] Delete `services/demo-data/{uv.lock,.python-version,.gitignore,.venv}` and the stale
      `apps/drone-sim/src-tauri/target/`
- [x] Security follow-ups: demo-data binds 127.0.0.1 and allows only local and Tauri origins
      (`EMBER_DEMO_DATA_ORIGINS` adds more); the planner orchestrator refuses to start without
      `EMBER_PLANNER_KEY`; the drone-sim CSP is loopback-only and `scripts/start.mjs` widens it to
      the hosts a launch names
- [ ] `.env.example`: the agent's settings deny it, so a human applies it. Drop `REDIS_URL` (unused);
      add `EMBER_EDGE_KEY`, `EMBER_PLANNER_KEY`, `EMBER_REDIS_URL`, `EMBER_API_URL`,
      `EMBER_DRONE_INFO_URL`, `EMBER_DEMO_DATA_URL`, `EMBER_DEMO_DATA_ORIGINS`
- [ ] First CI run on GitHub: the images job has never run (no Docker locally)

## Decisions

- demo-data stays in `services/` (it serves HTTP/WS to drone-runtime and drone-sim) but is not
  released as an image: it is demo tooling.
- `internal/` is a pnpm package rather than a `$TURBO_ROOT$` input, so `--affected` selects the Go
  services when only `internal/` changes without a turbo future flag.
- Actions are pinned to the newest release of the major already in use; major bumps stay with
  Dependabot.
- One Dockerfile per language, parameterised by build args, rather than one per service.

## Log

- 2026-10-03: Structure, CI/CD and per-language fixes done; full gate run locally (Go via a portable
  toolchain, `-race` not run: no cgo here). Next: a PR to see CI and the image builds go green.
- 2026-10-03: Deletions and security follow-ups done; `.env.example` left for a human.
