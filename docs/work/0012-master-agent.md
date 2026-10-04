# 0012: Master agent

**Status:** in-progress
**Touches:** packages/contracts, services/api, services/operator-agent, services/operator-uagent,
services/planner, services/drone-info, tools/seed-data, docs/architecture.md

## Goal

operator-agent is Ember's persistent master agent. It observes the api, keeps a decision log, decides
when to scan, verify, plan, assign, alert and replan, and talks to operators (ASI:One, dashboard),
responders (zone bundle feed) and civilians (iMessage through Photon). Every number and geometry it
uses comes from the planner or the api. The whole Lahaina demo runs from ASI:One.

## Plan

- [x] Contracts: road state, `roadIds`, alternate evacuation route, attack-zone approach,
      `sectorRisks` and richer `Weather` in `planner.ts`; watch zones, geography, detections, risk
      zones, roads, scans, edge servers (`zone.ts`); incidents, planner jobs, approvals, field reports
      (`incident.ts`); responders, assignments, targeted messages (`responder.ts`); civilian
      numbers, areas and messages (`civilian.ts`); agent chat and decisions (`agent.ts`)
- [x] planner: honour road state, emit `roadIds`, alternates, approaches and `sectorRisks`
      (`wire.py` mirror); worker defaults to the solo pool on macOS too
- [x] api: store interface (Prisma + memory), every route above, Redis enqueue, edge-manager
      client, weather providers (fixture default, demo-data, NWS), approval gate on outbound
      civilian messages, ordinary responder assignment, zone bundle and pairing
- [x] drone-info: forward detections frames to api `POST /v1/detections`
- [x] seed-data: Lahaina scenario (zone, roads, civilian areas, safe zones, stations, edge servers,
      responders, civilians) posted through the api
- [x] operator-agent: api client, tools, Claude reasoner, Gemini map images, deterministic policy loop, decision log
      and civilian memory (own schema), plan diff, chat endpoint, Photon adapter, rules router
- [x] operator-uagent: Python uAgent bridge (ACP, mailbox, manifest) forwarding to operator-agent;
      image in `.github/workflows/images.yml`
- [x] docs: architecture channels and data, api / operator-agent / planner / seed-data READMEs
- [ ] `.env.example` names (deny-listed for agents; add by hand, list below)
- [ ] Run with a real `ANTHROPIC_API_KEY` and tune the system prompt against the demo requests
- [x] Register operator-uagent on Agentverse (mailbox) and run the whole workflow as one Agent
      Chat Protocol conversation through Agentverse
- [x] Durable deployment: `scripts/asi1/ember.mjs` (setup, supervised start, status, restart,
      launchd), persistent Postgres, deep `/healthz`, `reset_demo`; guide in `docs/asi1-agent.md`
- [ ] Photon: a project id and secret; send and receive one iMessage
- [ ] Edge plane in the loop: Go edge-manager + edge-connector + drone-runtime swarm-sim, so scans
      actually fly (no Go toolchain on the machine this was built on)
- [ ] Terrain and fuel for the Lahaina zone (demo-data's world or LANDFIRE): today the planner
      assumes flat ground and timber, so sector scores differ mostly by population
- [ ] Satellite detections provider (NASA FIRMS) behind the api, as `satellite` detections
- [ ] Dashboard: approvals with hold-to-approve, incident timeline, decision log (it still runs on
      `src/sim/` dummy data)
- [ ] Responder app: show `assignment`, post field reports (`POST /v1/watch-zones/:id/reports`)
- [ ] Dashboard auth, so the operator key is per operator rather than shared

## Decisions

- Records go in the api; the agent stores only its decision log and per-civilian conversation
  memory, in its own Postgres schema (`operator_agent`).
- Autonomous loop steps (scan cadence, verification, escalation, replanning) are a deterministic
  policy over api state, logged as decisions with reason, inputs and confidence. Claude handles
  language: intent and tool sequencing in chat, parsing free-text reports, drafting and explaining.
  The demo loop must not depend on model sampling. Rejected: the model choosing every loop action.
- The ACP endpoint is a thin Python uAgent (`services/operator-uagent`) because ACP envelopes,
  Almanac registration and the Agentverse mailbox are implemented by the `uagents` library and have
  no maintained TypeScript implementation. It forwards each `ChatMessage` to operator-agent
  `POST /v1/chat` and holds no logic. Rejected: reimplementing envelope signing and the mailbox in TS.
- Geometry is stored as jsonb `LatLng` rings. Containment and distance tests on a few hundred
  shapes run in the api. Rejected for now: PostGIS columns, which Prisma only reaches through raw SQL.
- Plan diffing (`diff_plans`) lives in the agent: it compares two stored results and computes no
  geometry.
- Sector risk is a planner output (`sectorRisks`), computed from the same landscape and weather as
  the spread model. The agent ranks by it and never scores risk itself.
- Approvals: the api refuses an outbound civilian message unless it carries an approved approval
  whose recipient and body match exactly, or replies within 24 h to an inbound message from that
  civilian. Approval decisions need the operator key and the approval's confirmation code. From
  ASI:One, only allow-listed operator addresses can approve, and only with a deterministically parsed
  `approve <number> <code>`; no model tool approves anything. operator-agent holds the operator
  key for this only when `EMBER_OPERATOR_RELAY_KEY` is set; without it, approval is dashboard-only.
  Rejected: approvals without a code (a decision must name what it approves).
- Language model: Claude Haiku (`claude-haiku-4-5`) for every language call; Gemini only restyles
  the alert map image (owner's choice, 2026-10-03). The map is first drawn deterministically from
  the approved plan, and the render is sent whenever Gemini fails, because a generated image can
  move or drop roads; the text keeps the civilian-map link as the authoritative view.
- Model output is checked before use: structured answers through zod; drafted and explanatory text
  is discarded for the deterministic template when it states a number the facts it was given do not
  contain (`llm/guard.ts`). Rejected: trusting the system prompt alone.
- Open demo mode (`EMBER_ASI1_OPEN_OPERATOR=true`, the deployment default) lets any ASI:One user run
  the whole workflow. Approvals from addresses outside the operator list are accepted only while
  civilian texts are logged, not delivered; with Photon configured only listed operators approve.
  Rejected: allow-list only (judges and new users could not complete the workflow) and fully open
  (anyone could release real texts).
- One supervisor script (Node, no new repo dependencies) instead of per-service launchd jobs or
  Docker: the build machine has no Docker, and one process that restarts its children with backoff
  is enough for one host. Postgres comes from `DATABASE_URL` or an embedded Postgres in
  `~/.ember/pg` installed outside the repo.
- Without a Claude key the chat still works: a rules router (`intents.ts`) maps the demo requests to
  the same tools, so the demo does not depend on the model being reachable.
- Composite tools (`coordinate_response`, `update_road_state`, `rank_regions`) beside the fine-grained
  ones: the model calls one tool for a playbook instead of sequencing ten, which is what made the
  closed loop reliable. The spec's tool list is all there; `update_road_state` runs the closed loop.
- Civilian road reports are recorded as `uncertain` (the planner slows the road) until a responder
  or operator confirms; responder and operator reports set `blocked` directly.
- Simulated fires get their verification from the simulation: once a verification scan is asked
  for, the next tick adds a labelled simulated detection that corroborates it. Simulation-only
  actions run without approval, per the spec.
- The api stores records as jsonb documents in one table per collection. With no Postgres on the
  build machine, this kept the untested surface to one generic SQL class, which was then tested
  against an embedded Postgres. Rejected for now: typed Prisma models per record.

## Env

To add to `.env.example` by hand:

```
ANTHROPIC_API_KEY=
EMBER_CLAUDE_MODEL=claude-haiku-4-5
GEMINI_API_KEY=
EMBER_GEMINI_IMAGE_MODEL=gemini-2.5-flash-image
EMBER_PLANNER_KEY=
EMBER_AGENT_KEY=
EMBER_OPERATOR_KEY=
EMBER_INGEST_KEY=
EMBER_EDGE_MANAGER_URL=http://localhost:4004
EMBER_WEATHER_PROVIDER=fixture            # fixture | demo-data | nws
EMBER_DEMO_DATA_URL=http://localhost:8090
EMBER_API_STORE=prisma                    # prisma | memory
EMBER_API_URL=http://localhost:4001
EMBER_CIVILIAN_MAP_URL=http://localhost:5174
OPERATOR_AGENT_DATABASE_URL=
EMBER_OPERATOR_AGENT_URL=http://localhost:4006
EMBER_OPERATOR_ASI1_ADDRESSES=
EMBER_UAGENT_SEED=
PHOTON_PROJECT_ID=
PHOTON_PROJECT_SECRET=
```

## Log

- 2026-10-03: Built all of the above. Checks: api 29 tests (incl. SQL store against an embedded
  Postgres 17 via `EMBER_TEST_DATABASE_URL`; migrations apply and `prisma migrate diff` is empty),
  operator-agent 45 tests (incl. Postgres memory), planner 60, operator-uagent 11, seed-data 11,
  drone-info 8.
    - End to end on this machine, no Docker: Redis, api (memory store), real planner orchestrator
      and worker, Lahaina seed, operator-agent with the rules router (no Gemini key). All demo
      requests ran against real state: risk ranking from planner `sectorRisks`; cadence 25 → 10 min
      as the incident opened; simulated fire in S7 verified and escalated to Incident #1 by the loop
      alone; crews assigned with instructions from the plan; civilian alert drafted, wrong code
      refused, right code approved and delivered; "Ridge Road is blocked" replanned and messaged only
      the 2 crews whose approach used it; civilian texts answered from their route.
    - Scans fail with "edge-manager unreachable" (no Go here), recorded as failed scans.
    - Found and fixed on the way: Celery prefork fails on macOS (spawn), the planner worker now
      defaults to solo there too; the rules parser read "Can I take Highway 30" as a road name.
    - Next: a real Claude key, Agentverse registration, Photon credentials, `.env.example`.
- 2026-10-04: Deployed for ASI:One on the build machine under launchd. Agent
  `agent1qdxvsh9u6apatpn78dew2lvcvtvqq4kv80wjkrm2ys4wnmv5fg73cwj7nnx`, mailbox connected with an
  Agentverse key. Verified with a local uAgent speaking ACP through Agentverse: ack, then a reply
  with `TextContent` and `MetadataContent`; the whole workflow (risk, scan, simulate, coordinate,
  approve with the code from the reply, evacuation list, route explanation, Ridge Rd replan, diff,
  decision log, reset) completed in one conversation, twice. Killing operator-agent with SIGKILL:
  the supervisor restarted it within 17 s. Claude and Gemini keys not yet set: chat runs on the rules
  router, maps on the plain render.

- 2026-10-03: Read the planner, contracts, api and edge work. No Docker, Postgres or Go on this
  machine, so the api is tested through `inject` on the memory store, and the Prisma store is
  typechecked only. Started contracts.
