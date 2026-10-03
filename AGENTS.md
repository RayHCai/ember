# Ember: agent instructions

Ember is a wildfire detection and response platform: drones and edge servers watch forests, planners
predict spread and evacuation, and three viewpoints (operator dashboard, responder app, civilian
SMS/voice agent) act on it. `readme.md` is the product spec; this file is how to work in the repo.

## Read order

Read only what the task touches. Do not preload the whole `docs/` tree.

| Need                                       | Read                                     |
| ------------------------------------------ | ---------------------------------------- |
| Which service owns what, who talks to whom | `docs/architecture.md`                   |
| Code style, naming, comments, per language | `docs/style.md`                          |
| Current work, plans, decisions             | `docs/work/README.md`, then the one item |
| One service's contract                     | that service's `README.md`               |
| Cross-service wire shapes                  | `packages/contracts/src/`                |

## Layout

```
apps/        dashboard (Tauri), responder (Expo), civilian-map (web), contact-collector (web), drone-sim (Tauri)
services/    api, drone-info, messenger, voice-agent, operator-agent  (Fastify, TS)
             edge-manager, edge-connector                                            (Go, one root module)
             planner, drone-runtime                                                  (Python, uv workspace)
packages/    contracts (shared TS types)
tools/       demo-data, asset-builder (Python)
assets/      generated 3D models for the sim (.glb); built by tools/asset-builder, never edited by hand
internal/    Go packages shared by the Go services
docs/        architecture, style, work tracking
```

One monorepo, one gate. Every package, whatever its language, has a `package.json` whose scripts shell
to `scripts/go.mjs`, `scripts/uv.mjs` or `scripts/cargo.mjs`, so turbo drives all of it. A missing
toolchain skips with a line locally and fails in CI (`EMBER_REQUIRE_TOOLCHAIN`).

## Commands

```
pnpm install && uv sync --all-packages     # deps; also installs git hooks
docker compose up -d                       # postgres+postgis, redis
pnpm run lint | format:check | typecheck | build | test
pnpm run test --filter @ember/api          # one package
```

Run the narrowest check that proves your change, then the full gate before declaring done.

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
  changelogs, no "previously X" notes, no TODO lists inside design docs (those go in `docs/work/`).
- **Commits** are Conventional Commits (`feat(api): ...`), enforced by hook and CI. Scope is the
  package directory name.

## Work tracking

Non-trivial work (more than one sitting, or more than one service) gets an item in `docs/work/`
following `docs/work/_template.md`. Keep it current while working: plan, decisions, status. It is what
the next session (human or agent) resumes from, so write it for a reader with zero context.

## Subagent delegation

Subagents cost a fresh context each: every file they re-read is paid again. Delegate for isolation or
parallelism, never by reflex.

**Work directly when**

- the task is sequential or tightly coupled, or spans a handful of files
- you already hold the context the subagent would have to rebuild
- you could verify the result yourself in fewer tool calls than writing the brief

**Delegate when**

- a search would sweep many files and you need only the conclusion (use `Explore`)
- independent work can run in parallel (e.g. Go service + Python worker against a fixed contract)
- a large output (logs, test dumps, wide greps) would otherwise flood the main context

**How to delegate cheaply**

- **One subagent beats several.** Fan out only for truly independent work, and launch parallel
  ones in a single message.
- **Pick the smallest model that fits**: `haiku` for lookups and mechanical edits, `sonnet` for
  routine implementation and exploration, `opus` only for design or subtle debugging.
- **Write a self-contained brief**: goal, exact file paths, the contract or interface to honour,
  what "done" means, and the shape of the answer. Paste the relevant snippet rather than telling the
  agent to go find it.
- **Cap the reply**: ask for a conclusion, file:line references and a diff summary, not file dumps.
  E.g. "Reply in under 200 words."
- **Bound the scope**: name the directories it may read and edit. Forbid recursive delegation.
- **Do not double-check by spawning another agent.** Verify with a test or a targeted read.
- **Prefer the project agents** in `.claude/agents/` (they carry model and tool limits already).

## Comments

Default to none. One line, explaining why, never what. No banners, no history, no commented-out code.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
