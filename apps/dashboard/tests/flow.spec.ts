import type { Blast, Drone, EdgeServer, RiskZonesView, Scan } from '@ember/contracts';
import { expect, test } from '@playwright/test';
import type { Viewer } from 'cesium';
import { apiCall, collectErrors, DEMO_DATA_URL, expectMapAlive, signUp } from './helpers';

/** The dev build's store hooks (`main.tsx`). */
type EmberDev = { useMap: { getState(): { viewer: Viewer } } };

// The whole operator flow on the compose stack: its edge-connector, two simulated drones over
// Lahaina, edge-manager, drone-info, the planner and Demo Data.

test('onboards a zone, flies a live scan, plans and sends an approved blast', async ({ page }) => {
    test.setTimeout(15 * 60_000);
    const errors = collectErrors(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signUp(page);

    // The compose edge-connector may still belong to an earlier run's zone.
    for (const e of await apiCall<EdgeServer[]>(page, 'GET', '/v1/edge-servers'))
        if (e.zoneId)
            await apiCall(page, 'PATCH', `/v1/edge-servers/${e.edgeServerId}`, { zoneId: null });
    // Put Demo Data's clock where the drones' home is burning, and let it run.
    await page.request.put(`${DEMO_DATA_URL}/v1/clock`, {
        data: { scenario_time: '2023-08-08T15:40:00-10:00', speed: 1, paused: false },
    });

    await test.step('draw the boundary; Next stores the zone and plans its sites', async () => {
        await page.getByRole('button', { name: 'New watch zone' }).first().click();
        await expect(page.getByRole('textbox', { name: 'Find a place' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Next' })).toHaveCount(0);
        await page.waitForTimeout(2500);
        const corners: [number, number][] = [
            [480, 210],
            [960, 210],
            [960, 690],
            [480, 690],
        ];
        for (const [x, y] of corners) {
            await page.mouse.click(x, y);
            await page.waitForTimeout(250);
        }
        await page.mouse.click(...corners[0]!);
        await page.getByRole('button', { name: 'Next' }).click();
        await expect(page.getByRole('heading', { level: 1, name: /^Zone \d+$/ })).toBeVisible({
            timeout: 30_000,
        });
    });

    await test.step('the edge-connector and its drones connect on their own', async () => {
        await expect(page.getByText('Edge server connected')).toBeVisible({ timeout: 30_000 });
    });

    const zoneId = page.url().split('#/zones/')[1]!.split('/')[0]!;
    await expect
        .poll(
            async () => (await apiCall<Drone[]>(page, 'GET', `/v1/drones?zoneId=${zoneId}`)).length,
            { timeout: 60_000, intervals: [3000] },
        )
        .toBeGreaterThan(0);

    await test.step('a scan flies the drones live and maps the zone', async () => {
        await page.getByRole('button', { name: 'Scan', exact: true }).click();
        await expect(page.getByText('Scan started')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByRole('radio', { name: 'Detection' })).toHaveAttribute(
            'aria-checked',
            'true',
        );
        await expect(page.getByText(/[1-9] airborne/).first()).toBeVisible({ timeout: 90_000 });
        await expect
            .poll(
                async () =>
                    (await apiCall<Scan[]>(page, 'GET', `/v1/watch-zones/${zoneId}/scans`))[0]
                        ?.coverage ?? 0,
                { timeout: 4 * 60_000, intervals: [5000] },
            )
            .toBeGreaterThan(0.05);
        const risk = await apiCall<RiskZonesView>(
            page,
            'GET',
            `/v1/watch-zones/${zoneId}/risk-zones`,
        );
        test.info().annotations.push({
            type: 'risk zones',
            description: String(risk.riskZones.length),
        });
        await page.getByRole('button', { name: 'Stop scan' }).click();
        await expect(page.getByText('Scan stopped')).toBeVisible();
    });

    await test.step('turning on Suggestions runs the planners and shows their plan', async () => {
        await page.getByRole('switch', { name: 'Suggestions overlay' }).click();
        await expect(page.getByText('Path plans ready')).toBeVisible({ timeout: 3 * 60_000 });
        await expect(page.getByRole('switch', { name: 'Suggestions overlay' })).toHaveAttribute(
            'aria-checked',
            'true',
        );
    });

    await test.step('a civilian blast is queued only after hold-to-approve', async () => {
        // A civilian area on the map opens its inspector, which drafts the evacuation text.
        const at = await page.evaluate(() => {
            const { viewer } = (
                window as unknown as { __ember: EmberDev }
            ).__ember.useMap.getState();
            for (let i = 0; i < viewer.dataSources.length; i++)
                for (const e of viewer.dataSources.get(i).entities.values) {
                    if (!e.id.startsWith('community:') || !e.position) continue;
                    const p = viewer.scene.cartesianToCanvasCoordinates(
                        e.position.getValue(viewer.clock.currentTime)!,
                    );
                    if (p && p.x > 0 && p.y > 60 && p.x < 1440 && p.y < 900) return [p.x, p.y];
                }
            return null;
        });
        expect(at).not.toBeNull();
        await page.mouse.click(at![0]!, at![1]!);
        await page.getByRole('button', { name: 'Draft evacuation text' }).click();
        await page.getByRole('button', { name: 'Review for approval' }).click();
        const hold = page.getByRole('button', { name: /Hold to approve/ });
        const box = (await hold.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await expect(page.getByText(/queued for delivery/)).toBeVisible({ timeout: 10_000 });
        await page.mouse.up();
        const [blast] = await apiCall<Blast[]>(page, 'GET', `/v1/watch-zones/${zoneId}/blasts`);
        expect(blast?.state).toBe('queued');
        expect(blast?.approval?.approvedBy).toBeTruthy();
        await page.getByRole('button', { name: 'Done' }).click();
    });

    await expectMapAlive(page);
    expect(errors).toEqual([]);
});
