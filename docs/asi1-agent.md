# Ember on ASI:One

Ember is a wildfire detection and response agent. On ASI:One you can ask it where fire risk is
highest, send drones to look, simulate a fire, coordinate responders, see who must evacuate and why,
report a blocked road and watch it replan. Behind the chat, Ember takes real actions against its own
services: an api that keeps the record, a fire-spread planner, drone edge servers and messaging.

- **Agent address:** `agent1qdxvsh9u6apatpn78dew2lvcvtvqq4kv80wjkrm2ys4wnmv5fg73cwj7nnx`
- **Protocol:** Fetch.ai Agent Chat Protocol (ACP), via an Agentverse mailbox
- **Scenario:** Lahaina, Maui, the Aug 8, 2023 wind event (simulated, deterministic)

## Use it from ASI:One

1. Open [asi1.ai/chat](https://asi1.ai/chat) and send a message that mentions the agent:
   `@agent1qdxvsh9u6apatpn78dew2lvcvtvqq4kv80wjkrm2ys4wnmv5fg73cwj7nnx Analyze wildfire risk around Lahaina.`
   You can also find it on [Agentverse](https://agentverse.ai) by searching "Ember" or "wildfire" and
   start the chat from its page.
2. Keep going in the same conversation. The primary workflow, in order:

| You say                                          | Ember does (through its real services)                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Analyze wildfire risk around Lahaina.            | Runs the planner, ranks the zone's sectors by risk score with the main factors (wind, humidity, fuel, people nearby).         |
| Begin surveillance of the highest-risk region.   | Starts a drone mapping run over the top sector and sets the scan cadence from risk and weather.                               |
| Simulate a fire in Sector 7.                     | Files a simulated detection (moderate confidence), asks for a verification scan; the verification confirms it.                |
| Coordinate the response.                         | Opens an incident, plans fire spread, attack zones and evacuation routes, assigns crews, drafts civilian alerts for approval. |
| `approve <number> <code>` (Ember gives you this) | Records the operator decision; the approved texts (with a route map) go out.                                                  |
| Which civilians need evacuation?                 | Lists registered civilians in threatened areas, their route and alert status.                                                 |
| Show me why Civilian 4 was routed north.         | Explains the route from the plan: fire arrival, lead over the fire, roads, alternate, assumptions.                            |
| Responder 2 says Ridge Road is blocked.          | Records the road, finds the plans that used it, replans around it, notifies only the crews and civilians whose plan changed.  |
| What changed because of that?                    | Shows the plan diff and who was notified.                                                                                     |
| What happened and why?                           | Tells the story from Ember's decision log: every decision with its reason, inputs and confidence.                             |

Say **Reset the demo** to put the zone back to the start (closes incidents, removes simulated
fires, reopens roads) before trying it again.

Replies carry cards: tables for risk ranking, crews, civilians, plan diffs and the decision log. Every
number in them comes from the planner or the api record, never from a language model.

## How the agent works

```
ASI:One ──ACP──▶ Agentverse mailbox ──▶ operator-uagent (Python uAgent, no logic)
                                              │ POST /v1/chat
                                              ▼
                                    operator-agent (TypeScript master agent)
                         ┌───────────── chat: Claude picks tools ─────────────┐
                         │   loop: observe → assess → plan → act → replan     │
                         ▼                                                     ▼
                  api (record, Postgres) ──Redis queue──▶ planner (Python: spread, attack zones,
                         │                                 civilian impacts, evacuation routes,
                         │                                 sector risk) ──result──▶ api
                         ├──▶ edge-manager ──▶ edge-connectors ──▶ drones (scans)
                         └──▶ Photon iMessage (civilian texts, after operator approval)
```

- **operator-uagent** speaks ACP: it acknowledges every `ChatMessage`, forwards the text to
  operator-agent and answers with one `ChatMessage` (text plus the cards as metadata). It publishes
  the chat protocol manifest and a readme for Agentverse search.
- **operator-agent** is the master agent. Two ways in:
    - **Chat.** Claude (`claude-haiku-4-5`) reads the request and calls tools: 31 thin wrappers over api
      routes and playbooks (rank regions, start scan, simulate fire, coordinate response, update road
      state, explain route, what happened...). Without a Claude key, a rules router maps the
      workflow's requests to the same tools.
    - **Loop.** Every 10 s it reads the api and acts by fixed policy: rescan cadence from sector
      risk and weather, verify moderate detections, escalate confirmed fires, process field
      reports, send approved alerts, answer civilian texts. Every decision goes to its decision log
      (own Postgres schema) with its reason, inputs and confidence.
- **The planner computes, the agent never does.** Planning means enqueueing a planner job through
  the api and reading the result. Responder assignment is the api's. The agent only compares plans
  and words them.
- **Closed loop.** A road report is recorded at the api, every current plan that uses the road is
  found, the planner reruns (it routes around blocked roads), the two plans are diffed, and only the
  responders and civilians whose orders or routes changed are messaged.
- **Safety.** The api refuses any outbound civilian text without an approved approval record for
  that exact text, or a reply inside a conversation the civilian started. Approval needs the
  operator key and the approval's confirmation code; no model can approve. Ember never contacts
  authorities itself, never presents its forecast as an official order, and labels simulations.
- **Gemini** is used for one thing: restyling the route map sent with an approved alert. The map is
  drawn from the plan first, and that drawing is sent whenever Gemini is unavailable.

Detail: [architecture](architecture.md), [operator-agent](../services/operator-agent/README.md),
[operator-uagent](../services/operator-uagent/README.md), [api](../services/api/README.md),
[planner](../services/planner/README.md), work item [0012](work/0012-master-agent.md).

## Run it yourself

Needs Node 24 with pnpm, [uv](https://docs.astral.sh/uv/), and Redis (`brew install redis`, or
`docker compose up -d redis`). Postgres is optional: set `DATABASE_URL` (e.g. `docker compose up -d`),
or the script runs an embedded Postgres whose data lives in `~/.ember/pg`.

```bash
git clone <this repo> ember && cd ember
node scripts/asi1/ember.mjs setup     # installs, builds, writes ~/.ember/secrets.env with generated keys
```

Edit `~/.ember/secrets.env` (never commit it):

| Key                                          | Needed for                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| `AGENTVERSE_API_KEY`                         | connecting the mailbox, once (agentverse.ai → profile → API Keys; starts `eyJ`) |
| `ANTHROPIC_API_KEY`                          | Claude for free-form chat (optional: the workflow above works without it)       |
| `GEMINI_API_KEY`                             | styled alert maps (optional)                                                    |
| `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET` | real iMessage delivery (optional: texts are logged without it)                  |
| `EMBER_OPERATOR_ASI1_ADDRESSES`              | ASI:One addresses allowed to approve alerts once they reach real phones         |
| `EMBER_UAGENT_SEED`                          | generated: the agent's identity. Keep it, or the agent gets a new address       |

```bash
node scripts/asi1/ember.mjs start             # everything, supervised, in the foreground
node scripts/asi1/ember.mjs connect-mailbox   # once, in another terminal: prints the agent address
```

Then use the address on ASI:One as above. To keep it running across logins and crashes (macOS):

```bash
node scripts/asi1/ember.mjs install-launchd   # starts at login, restarted if it stops
node scripts/asi1/ember.mjs status            # health of every service and the mailbox
node scripts/asi1/ember.mjs restart           # after git pull + setup: graceful restart
node scripts/asi1/ember.mjs stop
```

Logs are in `~/.ember/logs/<service>.log` (rotated at 50 MB). Data persists in Postgres; the
Lahaina seed is reloaded idempotently on every start.

### Who can act

`EMBER_ASI1_OPEN_OPERATOR=true` (the default from `setup`) lets every ASI:One user run the whole
workflow, so anyone can try it. Approvals from addresses outside `EMBER_OPERATOR_ASI1_ADDRESSES` are
accepted only while civilian texts are logged rather than delivered; once Photon credentials are
set, only listed operators can approve. Set it to `false` to make everyone else read-only.

## Health

- `node scripts/asi1/ember.mjs status` checks every service; operator-agent's `/healthz` reports
  whether the api answers, when the loop last completed, and which model, map and messaging
  backends are active, and answers 503 when the loop is stuck.
- The supervisor checks each service every 15 s and restarts any that died or failed three checks
  in a row, backing off up to a minute. Under launchd the supervisor itself is restarted.
- The agent's identity is its seed: the same seed keeps the same address and Agentverse mailbox
  across restarts and machines.

## Troubleshooting

| Symptom                                           | Fix                                                                                                                                |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `status` says mailbox NOT connected               | Set `AGENTVERSE_API_KEY` and run `connect-mailbox`. The inspector's Connect button needs Chrome with local network access allowed. |
| ASI:One does not answer                           | Mention the full agent address; check `status`; read `~/.ember/logs/operator-uagent.log`.                                          |
| "Scan could not start (edge-manager unreachable)" | Expected without drones: the edge services are Go (`services/edge-manager`, `edge-connector`) and run next to the drones.          |
| Port 8001 in use                                  | Set `EMBER_UAGENT_PORT` in `~/.ember/secrets.env`.                                                                                 |
| Planner job never finishes                        | `~/.ember/logs/planner-*.log`; on macOS the worker uses Celery's solo pool.                                                        |
