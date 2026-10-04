# Ember

Ember is a wildfire detection and response agent. Autonomous drones and edge servers watch forests;
when they find fire, Ember forecasts its spread, tells responders where to stage, and texts the
evacuation route to residents of every affected ZIP code once a human operator approves.

## What Ember does

- Incident detection: a watched zone with fire seen by drones becomes an incident.
- Responder staging: the best places to fight the fire, with drop sites, tactics and how soon the
  fire arrives there, from Ember's planner.
- Evacuation alerts: for each ZIP code that must leave, a text naming the roads out and the
  destination. Each alert is sent by iMessage only after a human operator approves it.

## Example prompts

- Status.
- Is there a fire in Lahaina?
- Where should responders stage?
- Which evacuation alerts are waiting for approval?

## Limits

Ember's forecasts are a screening model, not official evacuation orders. Follow instructions from
local emergency authorities. Ember never messages a civilian without an operator's approval, and
approvals are given in the Ember dashboard, not in chat.
