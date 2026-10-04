# Development

How to work in the repo. The product spec is `docs/product.md`; service boundaries are in
`docs/architecture.md`.

## Where to look

| Need                                       | Read                       |
| ------------------------------------------ | -------------------------- |
| Which service owns what, who talks to whom | `docs/architecture.md`     |
| Code style, naming, comments, per language | `docs/style.md`            |
| What the product does                      | `docs/product.md`          |
| One service's contract                     | that service's `README.md` |
| Cross-service wire shapes                  | `packages/contracts/src/`  |

## Layout

```
apps/        dashboard (Tauri), civilian-map (web), contact-collector (web), drone-sim (Tauri)
services/    api, drone-info, operator-agent                (Fastify, TS)
             edge-manager, edge-connector                   (Go, one root module)
             planner, drone-runtime, demo-data              (Python, uv workspace)
             operator-uagent                                (Python, standalone uv project)
packages/    contracts (shared TS types)
internal/    Go packages shared by the Go services (@ember/go-internal, so turbo sees the dependency)
tools/       asset-builder, seed-data, fire-seg (Python)
assets/      generated 3D models for the sim (.glb), built by tools/asset-builder; brand/ holds the Ember mark
data/        released model weights; demo data built by `uv run demo-data build`
docker/      one Dockerfile per language; compose.yaml and .github/workflows/images.yml map services to them
scripts/     toolchain shims, git hooks, demo launcher, Raspberry Pi setup
docs/        product, architecture, style, development, Raspberry Pi
```

One monorepo, one gate. Every package, whatever its language, has a `package.json` whose scripts shell
to `scripts/go.mjs`, `scripts/uv.mjs` or `scripts/cargo.mjs`, so turbo drives all of it. A missing
toolchain skips with a line locally and fails in CI (`EMBER_REQUIRE_TOOLCHAIN`).

## Commands

```
pnpm install && uv sync --all-packages     # deps; also installs git hooks
docker compose up -d postgres redis        # stores only, for services run with pnpm dev
docker compose up -d --build               # all services (needs ./data from `uv run demo-data build`); desktop apps via pnpm
pnpm demo                                  # all services + a third drone + dashboard + drone-sim, on a 30 s demo zone
pnpm run lint | format:check | typecheck | build | test
pnpm run test --filter @ember/api          # one package
```

## Rules

- **Service boundaries are the architecture.** A service talks to another only over the channel
  `docs/architecture.md` names. No reaching into another service's DB tables or source. Shared Go
  code goes in `internal/`; shared TS types in `packages/contracts`.
- **Wire shapes change in all languages in one commit**: `packages/contracts` (TS), `internal/` (Go),
  and the Python package that speaks it.
- **Human-in-the-loop for outbound civilian alerts.** No code path sends an SMS, iMessage or call to a
  civilian without an operator approval record, except replies inside a conversation the civilian started.
- **Secrets** live in `.env` (gitignored), mirrored by name in `.env.example`. Never commit keys.
- **Docs move with code.** If you change what a service owns or how it talks, update
  `docs/architecture.md` and its README in the same commit. Edit the wrong sentence in place; no
  changelogs or TODO lists inside design docs.
- **Commits** are Conventional Commits (`feat(api): ...`), enforced by hook and CI. Scope is the
  package directory name. No tool attribution trailers in commit messages or PR descriptions.
- **Comments**: default to none. One line, explaining why, never what.
