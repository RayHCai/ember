-- CreateEnum
CREATE TYPE "scan_state" AS ENUM ('starting', 'mapping', 'stopping', 'done', 'failed');

-- CreateEnum
CREATE TYPE "surroundings_status" AS ENUM ('pending', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "blast_audience" AS ENUM ('civilians', 'responders', 'both');

-- CreateEnum
CREATE TYPE "blast_priority" AS ENUM ('routine', 'urgent', 'critical');

-- CreateEnum
CREATE TYPE "blast_area" AS ENUM ('zone', 'near_fire');

-- CreateEnum
CREATE TYPE "blast_state" AS ENUM ('pending_approval', 'queued');

-- AlterTable
ALTER TABLE "drones" ADD COLUMN     "kind" TEXT,
ADD COLUMN     "name" TEXT;

-- AlterTable
ALTER TABLE "edge_servers" ADD COLUMN     "name" TEXT;

-- AlterTable
ALTER TABLE "watch_zones" ADD COLUMN     "created_by" UUID,
ADD COLUMN     "next_scan_at" TIMESTAMP(3),
ADD COLUMN     "region" TEXT,
ADD COLUMN     "scan_every_hours" INTEGER;

-- CreateTable
CREATE TABLE "operators" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_sessions" (
    "id" TEXT NOT NULL,
    "operator_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operator_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edge_server_placements" (
    "id" UUID NOT NULL,
    "zone_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "connectivity_radius_m" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "edge_server_placements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scans" (
    "run_id" TEXT NOT NULL,
    "zone_id" UUID NOT NULL,
    "requested_by" TEXT NOT NULL,
    "state" "scan_state" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "cell_size_m" DOUBLE PRECISION NOT NULL,
    "results" JSONB NOT NULL,
    "error" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scans_pkey" PRIMARY KEY ("run_id")
);

-- CreateTable
CREATE TABLE "zone_surroundings" (
    "zone_id" UUID NOT NULL,
    "status" "surroundings_status" NOT NULL,
    "source" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3),
    "error" TEXT,
    "civilian_areas" JSONB NOT NULL,
    "roads" JSONB NOT NULL,
    "safe_zones" JSONB NOT NULL,
    "stations" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zone_surroundings_pkey" PRIMARY KEY ("zone_id")
);

-- CreateTable
CREATE TABLE "blasts" (
    "id" UUID NOT NULL,
    "zone_id" UUID NOT NULL,
    "audience" "blast_audience" NOT NULL,
    "priority" "blast_priority" NOT NULL,
    "area" "blast_area" NOT NULL,
    "state" "blast_state" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by" UUID,
    "approver_name" TEXT,
    "approved_at" TIMESTAMP(3),

    CONSTRAINT "blasts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "operators_email_key" ON "operators"("email");

-- CreateIndex
CREATE INDEX "operator_sessions_operator_id_idx" ON "operator_sessions"("operator_id");

-- CreateIndex
CREATE INDEX "edge_server_placements_zone_id_idx" ON "edge_server_placements"("zone_id");

-- CreateIndex
CREATE INDEX "scans_zone_id_started_at_idx" ON "scans"("zone_id", "started_at");

-- CreateIndex
CREATE INDEX "scans_state_idx" ON "scans"("state");

-- CreateIndex
CREATE INDEX "blasts_zone_id_created_at_idx" ON "blasts"("zone_id", "created_at");

-- AddForeignKey
ALTER TABLE "operator_sessions" ADD CONSTRAINT "operator_sessions_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edge_server_placements" ADD CONSTRAINT "edge_server_placements_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "watch_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scans" ADD CONSTRAINT "scans_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "watch_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zone_surroundings" ADD CONSTRAINT "zone_surroundings_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "watch_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blasts" ADD CONSTRAINT "blasts_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "watch_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A blast that reaches civilians is queued only with an operator's approval (AGENTS.md).
ALTER TABLE "blasts" ADD CONSTRAINT "blasts_civilians_need_approval" CHECK ("audience" = 'responders' OR "state" = 'pending_approval' OR ("approved_by" IS NOT NULL AND "approved_at" IS NOT NULL));
