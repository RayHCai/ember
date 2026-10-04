import type { DetectionRecord, Weather } from '@ember/contracts';
import type { AgentConfig } from './config.js';

/**
 * The autonomous loop's judgement, as pure functions of api state. Each returns what to do and
 * the reasons, which go into the decision log verbatim.
 */

const MAX_INTERVAL_MIN = 240;
const MIN_INTERVAL_MIN = 10;

/** 0 to 1 from weather alone, for zones with no plan yet. */
export function weatherSeverity(w: Weather | null): number {
    if (!w) return 0.2;
    const wind = Math.min(1, (w.windGustMps ?? w.windSpeedMps) / 30);
    const dry =
        w.relativeHumidityPct === null
            ? 0.5
            : Math.min(1, Math.max(0, (60 - w.relativeHumidityPct) / 45));
    const hot =
        w.temperatureC === null ? 0.5 : Math.min(1, Math.max(0, (w.temperatureC - 15) / 20));
    return Math.min(1, 0.45 * wind + 0.4 * dry + 0.15 * hot + (w.redFlagWarning ? 0.15 : 0));
}

export type CadenceInput = {
    /** The plan's highest sector score; null without a plan. */
    topSectorScore: number | null;
    weather: Weather | null;
    /** Unconfirmed detections in the zone. */
    openDetections: number;
    activeIncident: boolean;
};

/**
 * Minutes between surveillance scans. Continuous in risk (quadratic: a zone twice as risky is
 * scanned far more than twice as often), shortened by red-flag weather and anything unresolved.
 */
export function scanInterval(input: CadenceInput): { intervalMin: number; reasons: string[] } {
    const reasons: string[] = [];
    const weather = weatherSeverity(input.weather);
    const risk =
        input.topSectorScore === null ? weather : Math.max(input.topSectorScore, 0.6 * weather);
    reasons.push(
        input.topSectorScore === null
            ? `weather severity ${weather.toFixed(2)} (no plan yet)`
            : `top sector score ${input.topSectorScore.toFixed(2)}, weather severity ${weather.toFixed(2)}`,
    );
    let interval = MAX_INTERVAL_MIN * (1 - risk) ** 2;
    if (input.weather?.redFlagWarning) {
        interval *= 0.5;
        reasons.push('red flag warning');
    }
    if (input.openDetections > 0) {
        interval = Math.min(interval, 15);
        reasons.push(`${input.openDetections} unconfirmed detection(s)`);
    }
    if (input.activeIncident) {
        interval = MIN_INTERVAL_MIN;
        reasons.push('active incident');
    }
    const intervalMin = Math.max(MIN_INTERVAL_MIN, Math.round(interval / 5) * 5);
    return { intervalMin, reasons };
}

export type Triage =
    | { action: 'confirm'; reason: string; corroboratedBy: string[]; confidence: number }
    | { action: 'verify'; reason: string; confidence: number }
    | { action: 'watch'; reason: string; confidence: number }
    | { action: 'none'; reason: string; confidence: number };

function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
    const rad = Math.PI / 180;
    const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
    return Math.hypot(x, (b.lat - a.lat) * rad) * 6_371_008.8;
}

/** What to do about one detection, given every detection of its zone. */
export function triage(d: DetectionRecord, all: DetectionRecord[], config: AgentConfig): Triage {
    if (d.verification === 'confirmed' || d.verification === 'dismissed') {
        return { action: 'none', reason: `already ${d.verification}`, confidence: d.confidence };
    }
    const corroborating = all.filter(
        (o) =>
            o.id !== d.id &&
            o.verification !== 'dismissed' &&
            (o.droneId !== d.droneId || o.capturedAt !== d.capturedAt) &&
            metres(o.center, d.center) <= config.corroborateM,
    );
    if (corroborating.length) {
        const best = Math.max(d.confidence, ...corroborating.map((o) => o.confidence));
        // Two independent sightings: the chance both are wrong is the product of their misses.
        const combined =
            1 - corroborating.reduce((p, o) => p * (1 - o.confidence), 1 - d.confidence);
        return {
            action: 'confirm',
            reason: `corroborated by ${corroborating.length} detection(s) within ${config.corroborateM} m (best ${best.toFixed(2)}, combined ${combined.toFixed(2)})`,
            corroboratedBy: corroborating.map((o) => o.id),
            confidence: combined,
        };
    }
    if (d.confidence >= config.confirmConfidence) {
        return {
            action: 'confirm',
            reason: `confidence ${d.confidence.toFixed(2)} ≥ ${config.confirmConfidence}`,
            corroboratedBy: [],
            confidence: d.confidence,
        };
    }
    if (d.confidence >= config.verifyConfidence) {
        return {
            action: d.verification === 'verifying' ? 'none' : 'verify',
            reason: `confidence ${d.confidence.toFixed(2)} needs a second look`,
            confidence: d.confidence,
        };
    }
    return {
        action: 'watch',
        reason: `confidence ${d.confidence.toFixed(2)} below ${config.verifyConfidence}`,
        confidence: d.confidence,
    };
}
