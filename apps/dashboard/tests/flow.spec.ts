import type { Blast, EdgeServer, RiskZonesView, Scan } from '@ember/contracts';
import { expect, test } from '@playwright/test';
import { apiCall, collectErrors, DEMO_DATA_URL, expectMapAlive, signUp } from './helpers';

// The whole operator flow on the compose stack: its edge-connector, two simulated drones over
// Lahaina, edge-manager, drone-info, the planner and Demo Data.

const CENTER = { x: 720, y: 450 };

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

    const name = `Lahaina e2e ${Date.now().toString(36)}`;
    await test.step('draw the boundary', async () => {
        await page.getByRole('button', { name: 'New watch zone' }).first().click();
        await expect(page.getByRole('heading', { name: 'New watch zone' })).toBeVisible();
        await page.waitForTimeout(2500);
        await page.getByPlaceholder('e.g. Eaton Canyon').fill(name);
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
        await expect(page.getByText('Boundary ready')).toBeVisible();
        await page.getByRole('button', { name: 'Continue to edge servers' }).click();
        await expect(page.getByText('Watch zone created')).toBeVisible();
    });

    await test.step('plan sites and assign the edge-connector', async () => {
        await page.getByRole('button', { name: 'Suggest placements' }).click();
        await expect(page.getByText(/planned/).first()).toBeVisible({ timeout: 20_000 });
        await page.getByRole('button', { name: 'Clear' }).click();
        await page.getByRole('button', { name: 'Pinpoint a site' }).click();
        await page.mouse.click(CENTER.x, CENTER.y);
        const assign = page.getByRole('combobox', { name: /Assign an edge server/ }).first();
        await expect(assign).toBeVisible({ timeout: 15_000 });
        await expect(assign.locator('option')).not.toHaveCount(1, { timeout: 30_000 });
        await assign.selectOption({ index: 1 });
        await expect(page.getByText('Edge server deployed')).toBeVisible();
        await expect(page.getByText('Connected').first()).toBeVisible({ timeout: 15_000 });
        await page.getByRole('button', { name: /Continue/ }).click();
    });

    await test.step('drones pair through the edge server', async () => {
        await expect(page.getByText('Listening for drones')).toBeVisible();
        for (const drone of ['Osprey', 'Harrier'])
            await expect(page.getByText(drone).first()).toBeVisible({ timeout: 60_000 });
        await page.getByRole('button', { name: 'Finish and open zone' }).click();
        await expect(page.getByRole('heading', { level: 1, name }).first()).toBeVisible();
    });

    const zoneId = page.url().split('#/zones/')[1]!.split('/')[0]!;

    await test.step('a scan flies the drones live and maps the zone', async () => {
        await page.getByRole('button', { name: 'Run scan now' }).click();
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
        await page.getByRole('button', { name: 'Stop', exact: true }).click();
        await expect(page.getByText('Scan stopped')).toBeVisible();
    });

    await test.step('planners fill the suggestions overlay', async () => {
        await page.getByRole('button', { name: 'Run planners' }).click();
        await expect(page.getByText('Path plans ready')).toBeVisible({ timeout: 3 * 60_000 });
        await page.getByRole('switch', { name: 'Suggestions overlay' }).click();
        await expect(page.getByRole('switch', { name: 'Suggestions overlay' })).toHaveAttribute(
            'aria-checked',
            'true',
        );
    });

    await test.step('a civilian blast is queued only after hold-to-approve', async () => {
        await page.getByRole('button', { name: 'Event blast' }).click();
        await page.getByRole('radio', { name: 'Civilians' }).click();
        await page.getByRole('button', { name: 'Evacuate now' }).click();
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
