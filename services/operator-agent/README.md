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
      `pending_approval`: `Ember Alert: Evacuate by 3:40 pm HST via <roads> to <destination>.` for
      the soonest-hit area, then a line per other area and the map link. Its times are clock times (`EMBER_TIME_ZONE`), still right whenever it is approved.
      The latest time to leave is before the fire reaches the area or cuts its route (the route's
      clearance), less 10 minutes.
    - Then one responder blast, `Responder staging: <zone>`: the plan's best
      `EMBER_RESPONDER_ZONES` attack zones with drop site, tactic, radius, access time and fire
      arrival. The api queues responder blasts without approval.

All progress is the api's: an incident's plan is its `operator-agent` planner job, a ZIP is
drafted when a blast titled `Evacuation ZIP <zip>` exists since the incident began, and the
responder blast marks the incident notified. A restart resumes where it stopped. A new scan restarts
the risk-zone window, so fire still burning then is a new incident with a fresh plan and drafts.

Areas whose ZIP cannot be found are logged and shown in chat, not guessed.

## Notify phone

With `EMBER_NOTIFY_PHONE` set (the operator's own phone), the agent texts it each evacuation plan
once the plan, its route and its map are all ready, and nothing before (`src/notices.ts`). A fire
or at-risk area alone texts nothing.

For each newly succeeded plan (the agent's or an operator's), for the area fire reaches first:
`Ember Alert: Evacuate by 3:40 pm HST via Honoapiilani Hwy to Kapalua Airport.`, then that route on a
street map (`src/map.ts`): OpenStreetMap tiles framed on the watch zone, the fire and the route, with
the area joined to the route's first road by a dotted leg and the destination pinned. The map is
drawn before the text goes, and the two are sent back to back. Labels use the packaged DejaVu font,
since the service image has no system fonts; a tile that cannot be fetched is left blank. No safe
route sends the text without a map; a plan that reaches no community says no evacuation is needed.

Plans are checked on their own `EMBER_NOTIFY_TICK_MS` loop, every zone at once, apart from the
incident loop, so a slow ZIP lookup or civilian delivery never holds one back. Like the dashboard,
it reports plans that succeed while running, not what it finds at start, so a restart texts nothing
again; a zone created while running is watched from empty. A plan whose map cannot be drawn or
whose text fails is tried again the next tick. This phone is named by configuration and never read
from civilians, so it needs no approval; civilians are still texted only through approved blasts.

## New route by text

With Photon set up and `ANTHROPIC_API_KEY` set, the agent reads texts from the notify phone
(`src/reroute.ts`); texts from any other number are ignored. Claude Haiku (`claude-haiku-4-5`,
structured output `{ newRoute }`) decides whether a text asks for a new or different route; a
failed call counts as no. For a request, each zone with fire gets a fresh planner job,
`requestedBy: "operator-agent:reroute"`, unless one is already being planned. Nothing is sent until
that plan succeeds; its text and map then go out through the notify phone loop above, like any other
plan. With no fire burning, the agent texts back that there is no route to plan.

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

`pnpm --filter @ember/operator-agent send:test +15551234567` checks the Photon setup: it sends one
fixed test text (no alert, no civilians read) to that number, with the root `.env` loaded.

| Variable                                     | Default                      | Meaning                                                              |
| -------------------------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| `PORT`                                       | `4006`                       |                                                                      |
| `EMBER_API_URL`                              | `http://localhost:4001`      | api                                                                  |
| `EMBER_AGENT_KEY`                            | none                         | bearer for the api; the only key that lists civilians there          |
| `EMBER_AGENT_CHAT_KEY`                       | none                         | bearer `/v1/chat` requires (operator-uagent sends it); unset is open |
| `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET` | none                         | Photon Spectrum iMessage; unset logs approved texts instead          |
| `EMBER_CIVILIAN_MAP_URL`                     | none                         | civilian-map base URL linked from evacuation texts                   |
| `EMBER_OSM_USER_AGENT` | `ember-operator-agent (dev)` | identifies the agent to OpenStreetMap (Nominatim, map tiles) |
| `EMBER_MAP_TILE_URL` | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | street tiles under the route image |
| `EMBER_AGENT_TICK_MS`                        | `10000`                      |                                                                      |
| `EMBER_PLAN_RETRY_MS`                        | `120000`                     | wait before asking again for a failed plan                           |
| `EMBER_DELIVERY_LOOKBACK_MIN`                | `60`                         | approvals this recent before start are still sent                    |
| `EMBER_RESPONDER_ZONES`                      | `3`                          | attack zones in the responder brief                                  |
| `EMBER_NOTIFY_PHONE`                         | none                         | operator's phone (E.164) texted each evacuation plan and its map     |
| `ANTHROPIC_API_KEY` | none | Claude Haiku reads new-route texts from the notify phone; unset ignores them |
| `EMBER_NOTIFY_TICK_MS`                       | `2000`                       | how often new plans are checked for the notify phone                 |
| `EMBER_TIME_ZONE`                            | the host's                   | IANA zone alert times are written in, e.g. `Pacific/Honolulu`        |
