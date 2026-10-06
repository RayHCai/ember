# Ember

Ember is a wildfire detection and response platform: drone swarms coordinated by edge servers map
forests and spot fire, planners predict its spread and evacuation routes, and operators act on it from
a desktop dashboard while civilians are alerted only after an operator approves.

## Architecture

```mermaid
flowchart LR
    subgraph Field["Field (per watch zone)"]
        DR["drone-runtime<br/>Python · flight, swarm mapping, YOLO fire-seg"]
        EC["edge-connector<br/>Go · one edge server's drone network"]
    end

    subgraph Core["Core services"]
        API["api<br/>Fastify · system of record"]
        EM["edge-manager<br/>Go · edge registry, task fan-out"]
        DI["drone-info<br/>Fastify · live telemetry"]
        PL["planner<br/>Python · Celery spread / evacuation"]
        OA["operator-agent<br/>Fastify · incident response, alert drafts"]
        OU["operator-uagent<br/>Python · Fetch.ai uAgent"]
        PG[("Postgres")]
        RD[("Redis")]
    end

    subgraph Clients
        DB["dashboard<br/>Tauri · operator desktop"]
        SIM["drone-sim<br/>Tauri · 3D drone view"]
        CM["civilian-map<br/>web · read-only evacuation map"]
        CC["contact-collector<br/>web · civilian signup"]
    end

    DEMO["demo-data<br/>Python · simulated camera frames"]
    CIV(["Civilians · iMessage"])
    ASI(["ASI:One"])

    DR -- WS --> EC
    DEMO -- WS frames --> DR
    EC -- WS updates --> EM
    API -- HTTP tasks --> EM
    EM -- HTTP tasks --> EC
    EM -- HTTP registry, detections --> API
    EM -- HTTP ingest --> DI
    API --- PG
    API -- queue --> RD --> PL
    PL -- results --> API
    DB -- HTTP --> API
    DI -- WS --> DB
    DI -- WS --> SIM
    CM -- HTTP --> API
    CC -- HTTP --> API
    OA -- HTTP --> API
    OA -- approved alerts --> CIV
    ASI --> OU -- HTTP --> OA
```

Every arrow is the only channel between those two services; the full list, with routes, is in
[docs/architecture.md](docs/architecture.md).
