# Ember

Ember is a wildfire prevention and response agent. It watches forests with autonomous drones and
edge servers, monitors wildfire risk, forecasts fire spread, plans evacuations, coordinates
emergency responders, and drafts civilian alerts for human operator approval.

## What Ember does

- Wildfire prevention and risk monitoring: ranks areas by current wildfire risk.
- Autonomous drone surveillance: directs scans of the highest-risk regions.
- Fire spread forecasting: simulates a fire and forecasts where it goes.
- Evacuation planning: works out which civilians need to move and by which route.
- Emergency and responder coordination: plans responder routes and reacts to field reports.
- Civilian alerts: drafts personalised iMessage/SMS alerts with a route map, sent only after a human
  operator approves them.
- Explanations: every decision is logged, and Ember can say what happened and why.

## Example prompts

- Analyze wildfire risk around Lahaina.
- What area currently has the greatest wildfire risk?
- Begin surveillance of the highest-risk region.
- Simulate a fire in Sector 7.
- Coordinate the response.
- Which civilians need evacuation?
- Show me why Civilian 4 was routed north.
- Responder 2 says Ridge Road is blocked.
- What changed because of that?
- What happened and why?

## A conversation, start to finish

The demo runs on the Lahaina, Maui scenario (Aug 8, 2023 wind event, simulated). Ask in order:

1. "Analyze wildfire risk around Lahaina." → sector risk ranking with the main factors.
2. "Begin surveillance of the highest-risk region." → drone scan and scan cadence.
3. "Simulate a fire in Sector 7." → Ember verifies the detection, opens an incident and plans.
4. "Coordinate the response." → crews assigned to attack zones; civilian alerts drafted.
5. Approve the alert with the line Ember gives you, e.g. `approve 1 K3QF`.
6. "Responder 2 says Ridge Road is blocked." → Ember replans around the road and notifies only
   the people whose orders or routes changed.
7. "What changed because of that?" and "What happened and why?"

Every number comes from Ember's planner and records; nothing is estimated by a language model.

## Limits

Ember's forecasts are a screening model, not official evacuation orders. Follow instructions from
local emergency authorities. Outbound civilian alerts require human operator approval; Ember never
messages a civilian on its own.
