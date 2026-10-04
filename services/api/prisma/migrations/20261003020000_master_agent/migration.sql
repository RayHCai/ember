-- AlterTable
ALTER TABLE "civilians" ADD COLUMN     "civilian_area_id" TEXT,
ADD COLUMN     "location" JSONB,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "number" SERIAL NOT NULL,
ADD COLUMN     "zone_id" TEXT;

-- CreateTable
CREATE TABLE "counters" (
    "name" TEXT NOT NULL,
    "value" INTEGER NOT NULL,

    CONSTRAINT "counters_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "watch_zones" (
    "id" TEXT NOT NULL,
    "zone_id" TEXT,
    "doc" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watch_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zone_geography" (
    "id" TEXT NOT NULL,
    "zone_id" TEXT,
    "doc" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zone_geography_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "road_observations" (
    "id" TEXT NOT NULL,
    "zone_id" TEXT,
    "doc" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "road_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detections" (
    "id" TEXT NOT NULL,
    "zone_id" TEXT,
    "doc" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "detections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_zones" (
    "id" TEXT NOT NULL,
    "zone_id" TEXT,
    "doc" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edge_servers" (
    "id" TEXT NOT NULL,
    "zone_id" TEXT,
    "doc" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edge_servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scans" (
    "id" TEXT NOT NULL,
    "zone_id" TEXT,
    "doc" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planner_jobs" (
    "id" TEXT NOT NULL,
    "zone_id" TEXT,
    "doc" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "planner_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planner_results" (
    "id" TEXT NOT NULL,
    "zone_id" TEXT,
    "doc" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "planner_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incidents" (
    "id" TEXT NOT NULL,
    "zone_id" TEXT,
    "doc" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_events" (
    "id" TEXT NOT NULL,
    "zone_id" TEXT,
    "doc" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL,
    "zone_id" TEXT,
    "doc" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "civilian_messages" (
    "id" TEXT NOT NULL,
    "zone_id" TEXT,
    "doc" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "civilian_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "responders" (
    "id" TEXT NOT NULL,
    "zone_id" TEXT,
    "doc" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "responders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "responder_assignments" (
    "id" TEXT NOT NULL,
    "zone_id" TEXT,
    "doc" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "responder_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "responder_messages" (
    "id" TEXT NOT NULL,
    "zone_id" TEXT,
    "doc" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "responder_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "responder_pairing_codes" (
    "id" TEXT NOT NULL,
    "zone_id" TEXT,
    "doc" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "responder_pairing_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "responder_sessions" (
    "id" TEXT NOT NULL,
    "zone_id" TEXT,
    "doc" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "responder_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_reports" (
    "id" TEXT NOT NULL,
    "zone_id" TEXT,
    "doc" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "field_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "civilians_number_key" ON "civilians"("number");

-- CreateIndex
CREATE INDEX "civilians_zone_id_idx" ON "civilians"("zone_id");

-- CreateIndex
CREATE INDEX "watch_zones_zone_id_idx" ON "watch_zones"("zone_id");

-- CreateIndex
CREATE INDEX "zone_geography_zone_id_idx" ON "zone_geography"("zone_id");

-- CreateIndex
CREATE INDEX "road_observations_zone_id_idx" ON "road_observations"("zone_id");

-- CreateIndex
CREATE INDEX "detections_zone_id_idx" ON "detections"("zone_id");

-- CreateIndex
CREATE INDEX "risk_zones_zone_id_idx" ON "risk_zones"("zone_id");

-- CreateIndex
CREATE INDEX "edge_servers_zone_id_idx" ON "edge_servers"("zone_id");

-- CreateIndex
CREATE INDEX "scans_zone_id_idx" ON "scans"("zone_id");

-- CreateIndex
CREATE INDEX "planner_jobs_zone_id_idx" ON "planner_jobs"("zone_id");

-- CreateIndex
CREATE INDEX "planner_results_zone_id_idx" ON "planner_results"("zone_id");

-- CreateIndex
CREATE INDEX "incidents_zone_id_idx" ON "incidents"("zone_id");

-- CreateIndex
CREATE INDEX "incident_events_zone_id_idx" ON "incident_events"("zone_id");

-- CreateIndex
CREATE INDEX "approvals_zone_id_idx" ON "approvals"("zone_id");

-- CreateIndex
CREATE INDEX "civilian_messages_zone_id_idx" ON "civilian_messages"("zone_id");

-- CreateIndex
CREATE INDEX "responders_zone_id_idx" ON "responders"("zone_id");

-- CreateIndex
CREATE INDEX "responder_assignments_zone_id_idx" ON "responder_assignments"("zone_id");

-- CreateIndex
CREATE INDEX "responder_messages_zone_id_idx" ON "responder_messages"("zone_id");

-- CreateIndex
CREATE INDEX "responder_pairing_codes_zone_id_idx" ON "responder_pairing_codes"("zone_id");

-- CreateIndex
CREATE INDEX "responder_sessions_zone_id_idx" ON "responder_sessions"("zone_id");

-- CreateIndex
CREATE INDEX "field_reports_zone_id_idx" ON "field_reports"("zone_id");
