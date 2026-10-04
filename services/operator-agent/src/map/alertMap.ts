import type { CivilianAlertDraft } from '@ember/contracts';
import { describeError, type Ctx } from '../context.js';
import type { MapImage } from './imagery.js';
import { renderMapPng } from './render.js';

/**
 * The map for one approved alert, from the plan the alert was approved on. Gemini restyles the
 * render when configured; any failure sends the render itself, never a map from elsewhere.
 */
export async function alertMap(
    ctx: Ctx,
    zoneId: string,
    draft: CivilianAlertDraft,
): Promise<MapImage | null> {
    const [zone, geo, view] = await Promise.all([
        ctx.api.zone(zoneId),
        ctx.api.geography(zoneId),
        ctx.api.plan(draft.jobId),
    ]);
    const area = geo.civilianAreas.find((a) => a.id === draft.civilianAreaId);
    if (!view.result || !area) return null;
    const render = renderMapPng({
        title: `Evacuation route: ${area.name}`,
        boundary: zone.boundary,
        roads: geo.roads,
        area,
        result: view.result,
        safeZones: geo.safeZones,
    });
    const fallback: MapImage = { data: render, mimeType: 'image/png', generatedBy: 'render' };
    if (!ctx.imager) return fallback;
    try {
        return await ctx.imager.stylize(
            render,
            `wildfire evacuation route for ${area.name}; green is the route out, dashed teal the alternate, orange to dark red the forecast fire spread, dashed red closed roads`,
        );
    } catch (err) {
        ctx.log.warn(
            { err: describeError(err) },
            'map image generation failed; sending the render',
        );
        return fallback;
    }
}
