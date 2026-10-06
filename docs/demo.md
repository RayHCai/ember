# Run the demo on one PC

The whole system runs on a single Windows, macOS or Linux machine: the services in Docker, three
drones (two in a container, one on the host) flying over the 2023 Lahaina fire as replayed by Demo
Data, and the dashboard and drone-sim in the browser.

## Prerequisites

| Tool                                          | Version                   | Used for                          |
| --------------------------------------------- | ------------------------- | --------------------------------- |
| [Node.js](https://nodejs.org)                 | 24 (`.node-version`)      | pnpm, the dashboard and drone-sim |
| pnpm                                          | 11, via `corepack enable` | JS dependencies, scripts          |
| [uv](https://docs.astral.sh/uv/)              | recent                    | Python 3.12 and the host drone    |
| [Docker](https://docs.docker.com/get-docker/) | Compose v2, running       | Postgres, Redis and every service |

Go and Rust are only needed to work on the edge services or the Tauri shells; the demo builds the
Go services inside Docker. Allow several GB of disk for images and data.

## First-time setup

```bash
git clone https://github.com/RayHCai/ember.git && cd ember
corepack enable
pnpm install                  # JS dependencies and git hooks
uv sync --all-packages        # Python workspace, including the host drone

# The Lahaina scenario: ~270 MB of imagery and source data, then the fire model and 3D world.
cd services/demo-data
uv run demo-data download     # a few minutes
uv run demo-data build        # about 3 minutes; writes ../../data/derived
cd ../..
```

No `.env` is needed: compose has local defaults for every key. Copy `.env.example` to `.env` only
for the optional integrations (iMessage delivery, Claude reading reroute texts).

## Start

```bash
pnpm demo                # first run builds the service images (several minutes)
pnpm demo --no-build     # later runs reuse them
```

`pnpm demo` starts the compose stack, Vite for the dashboard and drone-sim, and a third drone
(`real-1`) on the host. It signs up a demo operator, creates the "Lahaina town" watch zone and opens
the dashboard. Logs go to `.demo/`.

1. Sign in as `operator@ember.test` / `ember-ops-2026`.
2. Wait for `[demo] all drones connected` in the terminal; drone-sim opens on `real-1`.
3. Press **Scan** in the dashboard. Three drones map the zone in about 30 s and report fire.

| URL                           | What                                |
| ----------------------------- | ----------------------------------- |
| http://localhost:5173         | Dashboard                           |
| http://localhost:5180         | drone-sim                           |
| http://localhost:8090/control | Demo Data scenario clock            |
| http://localhost:4010         | contact-collector (civilian signup) |
| http://localhost:4001         | api                                 |

## Stop

Ctrl+C stops the dev servers and the host drone. `docker compose down` stops the stack; add `-v` to
also wipe the database.

## Troubleshooting

- **A service is unhealthy:** `docker compose ps`, then `docker compose logs -f <service>`.
- **`no ./data/derived/world`:** the scenario has not been built; run the setup steps above.
- **No drones connect:** `docker compose logs -f edge-connector drone-fleet`, and
  `.demo/real-1.log` for the host drone.
- **A port is taken:** another copy of the stack is running; `docker compose down` first.

The same demo across a laptop, an edge server and a Raspberry Pi drone is `pnpm demo:laptop`; see
the header of [scripts/demo.mjs](../scripts/demo.mjs) and [docs/raspberry-pi.md](raspberry-pi.md).
