# @ember/operator-agent

Ember's incident responder. It watches every zone through the api; when drones find fire it gets a
plan, tells responders where to stage, and texts each affected ZIP its evacuation route once an
operator approves. ASI:One reaches it through [operator-uagent](../operator-uagent/README.md). See
[docs/architecture.md](../../docs/architecture.md) for its boundaries.

It never computes a route, spread or staging site: those are the planner's `PlannerResult`, read
through the api. It never texts a civilian without an operator's approval record.

## The loop

Every `EMBER_AGENT_TICK_MS`, for each watch zone (`src/incidents.ts`):

1. **Deliver.** Each evacuation blast that is `queued` with an approval, and not yet sent, goes to
   every civilian of its ZIP (`GET /v1/civilians?zipCode=`) through the transport. Approvals older
   than `EMBER_DELIVERY_LOOKBACK_MIN` before the agent started are taken as already sent, so a
   restart does not text everyone again.
2. **Detect.** A zone with `on_fire` risk zones (merged drone detections) has an incident, starting
   at the earliest `firstSeenAt`.
3. **Plan.** One planner job per incident, `requestedBy: "operator-agent"`; a failed one is asked
   again after `EMBER_PLAN_RETRY_MS`.
4. **Notify**, once the plan succeeds:
    - For each civilian area the plan marks `immediate` or `warning`, its ZIP from OpenStreetMap
      Nominatim (reverse geocoding the area's centre). Each ZIP gets one civilian blast, left
      `pending_approval`: the soonest-hit area, then every area's route out by road name and
      destination, the map link and the line saying it is a forecast, not an official order.
    - Then one responder blast, `Responder staging: <zone>`: the plan's best
      `EMBER_RESPONDER_ZONES` attack zones with drop site, tactic, radius, access time and fire
      arrival. The api queues responder blasts without approval.

All progress is the api's: an incident's plan is its `operator-agent` planner job, a ZIP is
drafted when a blast titled `Evacuation ZIP <zip>` exists since the incident began, and the
responder blast marks the incident notified. A restart resumes where it stopped. A new scan restarts
the risk-zone window, so fire still burning then is a new incident with a fresh plan and drafts.

Areas whose ZIP cannot be found are logged and shown in chat, not guessed.

## Chat

`POST /v1/chat` (`AgentChatRequest` → `AgentChatReply`, `packages/contracts/src/agent.ts`) answers
from the loop's latest view: per zone with fire, an `incident`, a `responder_plan` and an
`evacuation` card (each ZIP's alert: waiting for approval, or how many it was sent to). Naming a
zone narrows the answer; `help` explains. Chat never acts: approvals are the dashboard's.

## Run

```
EMBER_AGENT_KEY=ak pnpm --filter @ember/api dev            # with its usual keys
EMBER_AGENT_KEY=ak EMBER_AGENT_CHAT_KEY=ck pnpm --filter @ember/operator-agent dev
curl -s localhost:4006/v1/chat -H 'authorization: Bearer ck' -H 'content-type: application/json' \
  -d '{"channel":"dashboard","sender":"me","sessionId":"s","text":"status","sentAt":"2026-01-01T00:00:00Z"}'
```

| Variable                                     | Default                      | Meaning                                                              |
| -------------------------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| `PORT`                                       | `4006`                       |                                                                      |
| `EMBER_API_URL`                              | `http://localhost:4001`      | api                                                                  |
| `EMBER_AGENT_KEY`                            | none                         | bearer for the api; the only key that lists civilians there          |
| `EMBER_AGENT_CHAT_KEY`                       | none                         | bearer `/v1/chat` requires (operator-uagent sends it); unset is open |
| `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET` | none                         | Photon Spectrum iMessage; unset logs approved texts instead          |
| `EMBER_CIVILIAN_MAP_URL`                     | none                         | civilian-map base URL linked from evacuation texts                   |
| `EMBER_NOMINATIM_USER_AGENT`                 | `ember-operator-agent (dev)` | identifies the agent to OpenStreetMap Nominatim                      |
| `EMBER_AGENT_TICK_MS`                        | `10000`                      |                                                                      |
| `EMBER_PLAN_RETRY_MS`                        | `120000`                     | wait before asking again for a failed plan                           |
| `EMBER_DELIVERY_LOOKBACK_MIN`                | `60`                         | approvals this recent before start are still sent                    |
| `EMBER_RESPONDER_ZONES`                      | `3`                          | attack zones in the responder brief                                  |
