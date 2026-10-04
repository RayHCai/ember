# @ember/operator-agent

Ember's master agent. It watches the api, decides what to do about wildfire risk, acts through the
same api routes as the dashboard, and talks to operators (ASI:One, dashboard), responders (the
responder app's feed) and civilians (iMessage through Photon). See
[docs/architecture.md](../../docs/architecture.md) for its boundaries.

It never computes a route, spread, risk score or assignment. Planning means enqueueing a planner
job through the api and reading the `PlannerResult`; assignments are the api's. Claude (Haiku)
handles language; Gemini only restyles the map image sent with civilian alerts.

## The loop

Every `EMBER_AGENT_TICK_MS`, per watch zone (`src/loop.ts`):

| Step                 | Reads                                          | Decides (`src/policy.ts`)                                                                                     | Acts                                                          |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Conditions           | weather, latest plan                           | wind ±3 m/s, humidity ±10 %, a new red flag, or a plan older than `EMBER_RISK_PLAN_MAX_AGE_MIN` → new risk plan | planner job (sector risk is a planner output)                 |
| Detections           | unconfirmed detections                         | corroborated within `EMBER_CORROBORATE_M`, or ≥ `EMBER_CONFIRM_CONFIDENCE` → confirm; ≥ `EMBER_VERIFY_CONFIDENCE` → verify; else watch | verification scan; or escalate: incident, plan, coordinate |
| Field reports        | unprocessed reports                            | parsed into an observation (Claude schema, else rules)                                                        | road state → closed-loop replan; responder status            |
| Surveillance         | sector risk, weather, open detections, incidents | interval = 240 min × (1 − risk)², halved under a red flag, ≤ 15 with open detections, 10 in an incident   | records the cadence; starts a scan over the top sector when due |
| Approved alerts      | approved civilian alerts                       | —                                                                                                             | queues each text at the api, sends it, reports delivery       |
| Civilian texts       | inbound messages                               | parsed; answered from the civilian's area, plan, route and road states                                        | in-conversation reply; road reports and photos become observations |

Every significant decision goes to the decision log with its reason, inputs and confidence
(`GET /v1/decisions`). Simulated fires get their second look from the simulation, labelled as such.

### Closed-loop replanning

`handleRoadReport` (`src/playbooks/response.ts`): record the observation at the api; find every
attack-zone approach and evacuation route of the current plan whose `roadIds` include the road; if
any, enqueue a replan (the planner routes around blocked roads); diff old and new plans
(`src/diff.ts`); reassign through the api, which supersedes only crews whose approach or drop site
changed; message only those responders; draft civilian updates, for operator approval, only for
areas whose severity, arrival, route or destination changed; log the incident event and decision.

## Alert maps

An approved civilian alert is followed by a map image, drawn per area from the plan the operator
approved (`src/map/render.ts`): zone, roads (closed ones dashed red), forecast fire isochrones,
the route out, the alternate and the destination. With `GEMINI_API_KEY` set, Gemini restyles that
render for a phone screen, told to keep every shape and label; on any failure the render itself is
sent. The text keeps the civilian-map link, which is the authoritative view.

## Chat

`POST /v1/chat` (`AgentChatRequest` → `AgentChatReply`) is what operator-uagent forwards ASI:One
messages to. `approve <n> <code>` and `reject <n> <code>` are parsed by rule, never by the model,
and accepted only from operator addresses (`EMBER_OPERATOR_ASI1_ADDRESSES`) when
`EMBER_OPERATOR_RELAY_KEY` (the api's operator key) is set. Anything else goes to Claude with the
tools in `src/tools/`: 18 read-only tools anyone may use and 13 acting tools for operators, including `reset_demo`. Without
`ANTHROPIC_API_KEY`, or when Claude fails, `src/intents.ts` maps the requests below to the same tools.
Cards (risk ranking, incident, approval, crews, civilian plan, plan diff, decision log) come from
tools, never from the model.

Model text that states a number absent from the facts it was given is discarded for the template
(`src/llm/guard.ts`). Civilian alert drafts must also keep the map link and the line saying the
forecast is not an official order.

Demo requests, in order:

```
Analyze wildfire risk around Lahaina.
What area currently has the greatest wildfire risk?
Begin surveillance of the highest-risk region.
Simulate a fire in Sector 7.
Coordinate the response.
Which civilians need evacuation?
Show me why Civilian 4 was routed north.
Responder 2 says Ridge Road is blocked.
What changed because of that?
approve <n> <code>
What happened and why?
```

## Run

Locally, with no Docker: Redis, the api on its memory store, the planner, the Lahaina seed, then
this service.

```
redis-server --daemonize yes
EMBER_API_STORE=memory EMBER_AGENT_KEY=ak EMBER_OPERATOR_KEY=ok EMBER_PLANNER_KEY=pk pnpm --filter @ember/api dev
EMBER_PLANNER_KEY=pk uv run --package ember-planner ember-planner worker
EMBER_PLANNER_KEY=pk uv run --package ember-planner ember-planner orchestrator
uv run --package ember-seed-data ember-seed-data lahaina --api http://localhost:4001 --key ok
EMBER_AGENT_KEY=ak EMBER_OPERATOR_RELAY_KEY=ok EMBER_ASI1_OPEN_OPERATOR=true pnpm --filter @ember/operator-agent dev
curl -s localhost:4006/v1/chat -H 'authorization: Bearer ak' -H 'content-type: application/json' \
  -d '{"channel":"dashboard","sender":"me","sessionId":"s","text":"Analyze wildfire risk around Lahaina.","sentAt":"2026-01-01T00:00:00Z"}'
```

| Variable                        | Default                  | Meaning                                                                       |
| ------------------------------- | ------------------------ | ----------------------------------------------------------------------------- |
| `PORT`                          | `4006`                   |                                                                               |
| `EMBER_API_URL`                 | `http://localhost:4001`  | api                                                                           |
| `EMBER_AGENT_KEY`               | none                     | bearer for the api, and the key `/v1/chat` and `/v1/decisions` require        |
| `ANTHROPIC_API_KEY`             | none                     | Claude; unset uses the rules router and templates                             |
| `EMBER_CLAUDE_MODEL`            | `claude-haiku-4-5`       | every language call: chat, tools, parsing, drafting, explaining               |
| `GEMINI_API_KEY`                | none                     | Gemini, for alert map images only; unset sends the plain render               |
| `EMBER_GEMINI_IMAGE_MODEL`      | `gemini-2.5-flash-image` |                                                                               |
| `OPERATOR_AGENT_DATABASE_URL`   | none                     | Postgres for the `operator_agent` schema; unset keeps memory in process       |
| `EMBER_OPERATOR_ASI1_ADDRESSES` | none                     | comma-separated ASI:One sender addresses that are operators                   |
| `EMBER_OPERATOR_RELAY_KEY`      | none                     | the api's operator key, enabling `approve` from those addresses               |
| `EMBER_ASI1_OPEN_OPERATOR`      | `false`                  | demo only: every ASI:One sender is an operator                                |
| `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET` | none        | Photon Spectrum iMessage; unset logs civilian texts instead of sending them   |
| `EMBER_CIVILIAN_MAP_URL`        | none                     | civilian-map base URL for links in texts                                      |
| `EMBER_SIGNUP_URL`              | none                     | contact-collector URL sent to unknown senders                                 |
| `EMBER_NOMINATIM_USER_AGENT`    | `ember-operator-agent (dev)` | OpenStreetMap geocoding, for watch zones created by place name           |
| `EMBER_AGENT_LOOP`              | on                       | `off` serves chat only                                                        |
| `EMBER_AGENT_TICK_MS`           | `10000`                  |                                                                               |
| `EMBER_PLANNER_WAIT_MS`         | `90000`                  | how long a request waits for a plan                                           |
| `EMBER_CONFIRM_CONFIDENCE`      | `0.85`                   |                                                                               |
| `EMBER_VERIFY_CONFIDENCE`       | `0.35`                   |                                                                               |
| `EMBER_CORROBORATE_M`           | `500`                    |                                                                               |
| `EMBER_RISK_PLAN_MAX_AGE_MIN`   | `30`                     |                                                                               |

`EMBER_TEST_DATABASE_URL=postgresql://... pnpm --filter @ember/operator-agent test` also runs the
Postgres memory tests.
