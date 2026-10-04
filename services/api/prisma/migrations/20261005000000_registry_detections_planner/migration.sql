-- CreateEnum
CREATE TYPE "mapping_run_state" AS ENUM ('mapping', 'stopping', 'done');

-- CreateEnum
CREATE TYPE "risk" AS ENUM ('at_risk', 'on_fire');

-- CreateEnum
CREATE TYPE "planner_job_state" AS ENUM ('queued', 'gathering', 'planning', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "watch_zones" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "boundary" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "watch_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edge_servers" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "zone_id" UUID,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "connectivity_radius_m" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "edge_servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drones" (
    "id" TEXT NOT NULL,
    "edge_server_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mapping_runs" (
    "run_id" TEXT NOT NULL,
    "edge_server_id" TEXT NOT NULL,
    "zone_id" UUID NOT NULL,
    "state" "mapping_run_state" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "connectivity_radius_m" DOUBLE PRECISION NOT NULL,
    "cell_size_m" DOUBLE PRECISION NOT NULL,
    "coverage" DOUBLE PRECISION NOT NULL,
    "cells" INTEGER[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mapping_runs_pkey" PRIMARY KEY ("run_id","edge_server_id")
);

-- CreateTable
CREATE TABLE "detection_frames" (
    "id" UUID NOT NULL,
    "drone_id" TEXT NOT NULL,
    "frame_id" INTEGER NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "scenario_time" TEXT NOT NULL,
    "pose" JSONB NOT NULL,
    "camera" JSONB NOT NULL,
    "detector" TEXT NOT NULL,
    "zone_id" UUID,
    "edge_server_id" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "detection_frames_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detections" (
    "id" UUID NOT NULL,
    "frame_id" UUID NOT NULL,
    "detection_id" TEXT NOT NULL,
    "risk" "risk" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "bbox_px" DOUBLE PRECISION[],
    "ground" JSONB NOT NULL,
    "center_lat" DOUBLE PRECISION NOT NULL,
    "center_lng" DOUBLE PRECISION NOT NULL,
    "area_m2" DOUBLE PRECISION NOT NULL,
    "peak_temp_k" DOUBLE PRECISION,

    CONSTRAINT "detections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planner_jobs" (
    "id" UUID NOT NULL,
    "zone_id" UUID NOT NULL,
    "state" "planner_job_state" NOT NULL DEFAULT 'queued',
    "requested_by" TEXT NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "options" JSONB,
    "message" TEXT,
    "result" JSONB,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planner_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "edge_servers_zone_id_idx" ON "edge_servers"("zone_id");

-- CreateIndex
CREATE INDEX "drones_edge_server_id_idx" ON "drones"("edge_server_id");

-- CreateIndex
CREATE INDEX "mapping_runs_zone_id_idx" ON "mapping_runs"("zone_id");

-- CreateIndex
CREATE INDEX "detection_frames_zone_id_captured_at_idx" ON "detection_frames"("zone_id", "captured_at");

-- CreateIndex
CREATE UNIQUE INDEX "detection_frames_drone_id_frame_id_captured_at_key" ON "detection_frames"("drone_id", "frame_id", "captured_at");

-- CreateIndex
CREATE INDEX "detections_frame_id_idx" ON "detections"("frame_id");

-- CreateIndex
CREATE INDEX "planner_jobs_zone_id_requested_at_idx" ON "planner_jobs"("zone_id", "requested_at");

-- AddForeignKey
ALTER TABLE "edge_servers" ADD CONSTRAINT "edge_servers_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "watch_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drones" ADD CONSTRAINT "drones_edge_server_id_fkey" FOREIGN KEY ("edge_server_id") REFERENCES "edge_servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mapping_runs" ADD CONSTRAINT "mapping_runs_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "watch_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detection_frames" ADD CONSTRAINT "detection_frames_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "watch_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detections" ADD CONSTRAINT "detections_frame_id_fkey" FOREIGN KEY ("frame_id") REFERENCES "detection_frames"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planner_jobs" ADD CONSTRAINT "planner_jobs_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "watch_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;
