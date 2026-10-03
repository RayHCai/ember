/** "2h 40m", "35m", for fire arrival times in minutes. */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

/** Compass point for a bearing, for "head runs south-south-west". */
export function compass(bearingDeg: number): string {
  const points = ["north", "north-north-east", "north-east", "east-north-east", "east", "east-south-east", "south-east", "south-south-east", "south", "south-south-west", "south-west", "west-south-west", "west", "west-north-west", "north-west", "north-north-west"];
  return points[Math.round((((bearingDeg % 360) + 360) % 360) / 22.5) % 16]!;
}
