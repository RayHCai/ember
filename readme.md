---

## Summary

Forest fires are hard to detect, prevent , evacuate, and fight. A large part is because of the size of a forested area → Humans can’t keep detailed tabs on every inch of foliage.

Solution:

- Desktop app dashboard where you can create new “watch zones.” A full-sized map is displayed, and you can select areas of a map that is a forested area. Simple YOLO model or open data confirms that the area is a forest and selects the entire thing (auto-fits the area). A user can manually drag + add edges to this mesh.
- Next step → click process to determine where a team should deploy edge servers. These will be centers that are added to a decentralized local network so drones can communicate. Since drones inherently have a radius, we need multiple networks to communicate (can’t just have 1 central fleet). As they connect to the primary server, dashboard should display + give a radius and coverage percentage.
- Then, we can connect drones to the edge servers. Ideally, this would be done through some sort of nearby pairing system (UUID tagging + tracking + local network) → i.e, place a drone nearby and it joins the fleet. All of this can be seen from the dashboard → full map of the forest (covered zone is highlighted in a semi-transparent color), edge server locations + coverage radius (anything not covered is grayed out), and individual drone locations.
- Then, from the dashboard:
1. Chron job and manual option (can set a repeat time in dashboard) that pushes out the fleet, scanning and identifying the following: no risk (keep same map color), at risk (yellow coverage), and currently on fire (red). You should be able to watch the drones fly + map in real-time. This shouldn’t be the main page of the dashboard, but a separate page. There should also be live notifications + mobile push notifications in case of events. 
2. Civilian path plan → inference looks at nearby people + homes and determines the most at risk locations currently (displayed as gradient of predicted times when they will be hitb with fires ). This should be shown in a large map.
3. Incident path plan → inferences looks at nearby forest locations to determine where the fire spread and determines the best response locations. Mark as a gradient where the fire will spread (similar to 2).

The dashboard should combine #2 and #3 into a single viewer. The dashboard should display #1 and, #2 and #3 as overlay panels on the main screen. The primary screen of the dashboard should be a list of cards for each watch site (forest).

The first 3 bullet points are the onboarding process for a new watch site. A site is not complete until at least the map/boundary has been drawn. You should be able to continuously update the size/area of the map and recompute best edge server deployment zones. 

The desktop app dashboard is the “operator” viewpoint. There are 3 total viewpoints:

- Operator
- Responder
- Civilian (no app → agentic SMS/iMessage)

The Responder viewpoint is a mobile app. Civilians don't install anything: they interact with Ember through an agent over text. The operator also gets an agent (Operator Agent) that can drive the dashboard from natural language.

Responder viewpoint:

- Connect to a watch site by scanning a QR code from the operator dashboard (there should be a connect button in the viewpoint)
- Receive push notifications about new incidents, updates, etc from the dashboard + operator (direct 1 to N communication channel)
- Have a map of the forest on a mobile view (once assigned to a watch site) → this should download locally first when syncing. If there is network connection, then we can just sync with the operator dashboard.
- The map should highlight the areas that are high incident, the predicted path of fire, and highlight in circles the recommended prevention sites

Civilian viewpoint (agentic SMS):

- Subscribe by texting the Ember number (SMS / iMessage) with an address or shared location → agent geocodes it and links the civilian to the nearest watch site(s)
- Two-way conversation, not just alerts. Civilians can ask “is my house at risk?”, “when should I leave?”, “which road is safe?” and the agent answers from live planner output (risk zones, predicted fire spread, evacuation path)
- Proactive outreach: when an incident or operator event blast affects a civilian's area, the agent texts them a short summary + an evacuation route (link to a lightweight read-only map page, no install)
- Context persists per civilian (location, household notes like pets/mobility needs, past messages) so follow-ups are personalized. Check-ins (“reply SAFE when evacuated”) roll up to the operator dashboard
- Inbound reports: civilians can text in smoke or fire sightings (with photos) → agent structures them into a report that appears on the operator map for verification

Operator Agent:

- Chat/voice copilot inside the operator dashboard. Takes natural-language commands and calls the same API actions the UI does: “run a scan on Zone 3 now”, “show coverage gaps”, “run the civilian + responder planners”, “text everyone within 2 mi of the north fire to evacuate via Route 9”
- Summarizes state: active incidents, drone/server health, civilian check-in status, unread civilian reports
- Drafts event blasts and responder messages; operator approves before anything is sent to civilians (human-in-the-loop for outbound alerts)

The Responder viewer and the civilian map page should look as similar to the operator map as possible.

## Agent tracks targeted

| Track | How Ember uses it |
| --- | --- |
| Photon – Agents in iMessage | Operator Agent runs on iMessage through Photon's Spectrum framework: persistent per-civilian context, proactive alerts, two-way Q&A, photo-based fire reports |
| Relay – Interactive Agents | Operator Agent also available in the Relay app (text, call, video chat): text for alerts, video to show the fire/smoke to the agent |
| ElevenLabs | The Operator Agent's voice mode (TTS) |
| FetchAI – ASI:One Agent Challenge | Operator agent registered as a uAgent, discoverable through ASI:One (“is there a wildfire risk near me?”). It takes real actions (subscribe, report, trigger planners, send blasts) |
| MHacks – Actually Intelligent (AI) / Sustainability | Agents act on live drone + planner data instead of being a chatbot wrapper; wildfire prevention and evacuation |

---

# Architecture

- Operator Dashboard
    - Tauri (Rust + TS)
    - Views
        - Login/signup → simple email + password auth. Sessions stored on device and auto-timed out after a week
        - Watch-zone list → list of cards + create button + search/filter
        - Create watch-zone → map + optional address input. Click on map to place a “boundary” (blue dot). Connect boundaries (after placing the first dot, each subsequent boundary should have an auto-connection displayed by a thin line) together until an area is filled (fill in with semi transparent blue). Optional suggested auto-fit to detected forested area (YOLO + open data model to move nodes around based on satellite imagery)
        - View watch-zone (primary page):
            - Interactable map-view with forest colored in by actual map colors (outside areas should be white/black/grayed)
            - If coverage below 90% → button to suggest placements. Displayed by a server icon + semi-transparent pink circle “connectivity radius”. Since these are pending, they should be flashing in/out
            - Existing edge-servers should be displayed by the same icon + connectivity radius (except these shouldn’t be flashing in/out). Current coverage should be displayed in a metrics view
            - Existing drones should be displayed by a drone icon at their last reported position
            - Servers and drones should be able to be hovered + clicked to show detailed health information in an inspector sidebar (as well as various other tools)
            - Operator panel → chron settings and manual run to start drone flight/detection/mapping, buttons to start detection for civilian and responder path suggestions
            - Overlay toggle for the map. Here are the different modes:
                - Operator (default if there are no detections/past runs): display servers + current live position of drones
                - Detection map: base is a black and white map (boundary of forest is blue highlighted), as areas get mapped it should fill in with color (if there has already been mapping then we can keep it filled in with what has been viewed), identified areas are custom colored/overlayed zones based on risk (yellow for at-risk, red for current fire)
                - Suggestions (overlay toggle on top of detection map): if there are suggested paths → predicted fire movement areas are marked by custom colored/overlayed zones (similar to a weather hurricane predicted movement graph → show the predicted movement of the fire spread), highlight affected civilian areas in a gradient radius (i.e, if nothing is done about the fire, this is where civilians will be impacted → 100% in gradient is most soon, 0% in gradient is least soon). For civilian areas, show a recommended path (line) of movement away from the fire (i.e, if there are multiple fires around the area, show an evacuation plan that avoids these). For responders, show the optimal response locations in the map with drop site + radius (shown as a circle overlay)
            - Event/notification blast → send events/status information to either civilians, responders, or both
- API
    - Fastify (TS)
- Edge Manager
    - Go
    - Connections:
        - API
            - In a deployed instance, there will be N edge servers. Instead of API fan-out for 1-N communication, edge manager will take a 1-1 communication with API. Then fan out to N edge servers accordingly.
            - Receives → task info (start mapping, stop mapping). Payload is zone id, connection URLs for each edge server, and task type
        - Drone Info
            - Aggregates edge updates and sends to drone info
- Edge Server Connector
    - Go
        - Spawns a local network server for drones to connect + communicate with
        - Stores each connected drone ID + info in database
        - Receives task information from edge manager and fans out 1-N messages to connected drones
        - Aggregates drone updates and sends to edge manager
        - Creates WS connection for drones to communicate with during runs
    - Demo:
        - Mac Mini
- Drone Runtime
    - PY
        - Path-finding, goal engine (Hungarian algorithm again?), swarm interaction
        - Performs → mapping, vision classification (YOLO?)
        - Vision → identifies areas in 3 categories: no risk, at risk, on-fire using cameras. Drones will be LiDar + camera for vision/color
        - Send updates to WS connection with edge manager
        - Connect button to find local server nearby then sends a connection request + hardware/device information
    - Demo:
        - Raspberry Pi
- Planner Orchestrator
    - Celery (PY)
    - 1-1 communication with API for task fan-out:
        - Watches Redis queue
        - Picks up task and creates worker + passes in all required information/data
- Planner Worker
    - Celery (PY)
    - Independent inference worker
        - Does path-planning + suggestion algorithm
- Drone Info
    - Fastify (TS)
- Responder App
    - Expo (React Native + TS)
    - Views
        - 
- Operator Agent
    - Fastify (TS) service, chat + voice panel in the Tauri dashboard
    - Tool calls: start/stop scans, run planners, query coverage/health, draft + send event blasts (needs operator approval), summarize incidents and civilian check-ins
- Civilian Map Page
    - Lightweight read-only web page linked from texts (risk zones, predicted spread, evacuation path). Not an app
- Demo Data
    - PY
- Drone Sim
    - PY + TS (Three.js)

https://lucid.app/lucidchart/e0e2134d-5625-4d79-b03e-ece5d3daea76/edit?viewport_loc=-1121%2C-737%2C2760%2C1581%2C0_0&invitationId=inv_d5d61c69-63ae-4f3d-88d0-0ed5a1b0e5e9