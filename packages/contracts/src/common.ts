export type RiskLevel = 'none' | 'at_risk' | 'on_fire';

export type LatLng = { lat: number; lng: number };

export type WatchZoneId = string & { readonly __brand: 'WatchZoneId' };
