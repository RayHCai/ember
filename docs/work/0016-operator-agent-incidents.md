# 0016: Operator agent incident response

**Status:** in-progress
**Touches:** services/operator-agent, services/operator-uagent, services/api, packages/contracts, compose.yaml

## Goal

When drones find fire in a watch zone, operator-agent gets a plan, posts where responders should
stage, drafts one evacuation text per affected ZIP for operator approval, and sends each approved
one by iMessage (Photon) to every civilian signed up in that ZIP. ASI:One can ask it for status
through the operator-uagent bridge on Agentverse.

## Plan

- [x] api: `EMBER_AGENT_KEY`, and `GET /v1/civilians?zipCode=` readable only with it
- [x] contracts: `CIVILIANS_PATH`; `agent.ts` (chat request, reply, cards)
- [x] operator-agent: incident loop, alert composition, Photon transport, chat, tests
- [x] operator-uagent: bridge from `feat/live-demo`, trimmed to the new chat shape, own uv project
- [x] compose: agent keys and Photon passthrough; docs
- [ ] `.env.example`: `EMBER_AGENT_KEY`, `EMBER_AGENT_CHAT_KEY`, `PHOTON_PROJECT_ID`,
      `PHOTON_PROJECT_SECRET`, `EMBER_CIVILIAN_MAP_URL`, `EMBER_UAGENT_SEED`
- [ ] Run end to end: compose stack, a scan that finds fire, approve a draft in the dashboard, a
      real Photon send to a test phone
- [ ] Replan when the fire grows or a road closes within one incident (today: one plan per incident)

## Decisions

- Taken from `feat/live-demo`: only the Photon transport and the uAgent bridge. Its master agent
  (decision log, Claude/Gemini, surveillance, responders, incidents API) needs api records master
  does not have, and was left out.
- ZIP of an area by reverse geocoding its centre (Nominatim): civilians carry only a ZIP, the plan
  only areas. Areas with no ZIP are reported, not guessed.
- Approval stays the api's blast approval (dashboard, signed-in operator). Chat cannot approve: the
  api's approve route takes only an operator session.
- No agent database: incident progress is read back from planner jobs (`requestedBy`) and blast
  titles, so restarts resume. Delivery is remembered in process, bounded by a lookback on approval
  time so a restart never re-texts old alerts.
- operator-uagent is outside the root uv workspace: uagents → cosmpy pins protobuf < 6, which
  downgraded protobuf (7.36 → 5.29) and onnx (1.23 → 1.22) for drone-runtime and fire-seg.
- `/v1/chat` has its own key (`EMBER_AGENT_CHAT_KEY`) so the bridge never holds the key that reads
  civilians' phone numbers.

## Log

- 2026-10-04: Built and tested (api 20, operator-agent 18, operator-uagent 11 tests). Next: env
  example, end-to-end run with the compose stack and a Photon test number.
- 2026-10-04: Photon credentials and generated agent keys in `.env`; `send:test` sent one test
  iMessage, accepted by Photon. Next: durable delivery record (a restart within the lookback
  re-sends approved alerts), then the end-to-end run.
- 2026-10-04: Notify phone (`EMBER_NOTIFY_PHONE`, `src/notices.ts`): fire, risk and new-plan
  notices mirrored from what the dashboard announces, with the plan's routes rendered to a PNG
  (`src/map.ts`, resvg + packaged DejaVu font). Real Photon send of all four (fire, risk, plan text,
  map image) to the operator's phone accepted. Next: durable delivery record, end-to-end run.
- 2026-10-04: Route image is now a street map: OpenStreetMap tiles framed on the route, route drawn in
  web-mercator on them (Google Static Maps declined: no server key). Live preview (Lahaina to Kapalua
  Airport) sent through Photon.
- 2026-10-04: No notify texts in the demo: the compose operator-agent image predated the notices
  code; rebuilt it. Notices now run before civilian delivery, so a delivery error cannot hold them
  back. Texts cut to one line each (`Ember Alert: Evacuate by 3:40 pm HST via ... to
...`), the disclaimer dropped; civilian drafts use clock times
  (`EMBER_TIME_ZONE`) since they wait for approval. Map framed on zone, fire and route, the area
  joined to the route by a dotted leg.
- 2026-10-04: Notify phone texts only the evacuation plan now: no fire or risk texts. The plan's map
  is drawn before its text is sent, then the two go back to back. Notices run on their own
  `EMBER_NOTIFY_TICK_MS` loop (all zones at once) instead of inside the incident loop; a plan whose
  map or text fails is retried next tick. `EMBER_NOTIFY_COOLDOWN_MIN` removed.
- 2026-10-04: New route by text (`src/reroute.ts`): Photon inbound texts from the notify phone are
  classified by Claude Haiku (structured output); a route request queues a fresh plan
  (`operator-agent:reroute`) per burning zone, and `Notices` sends it when it succeeds. Needs
  `ANTHROPIC_API_KEY` in `.env` (and its name in `.env.example`). Not tried against live Photon yet.
