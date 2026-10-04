import type Anthropic from '@anthropic-ai/sdk';
import type { LatLng } from '@ember/contracts';
import { leadEvacuation, usable } from './alerts.js';
import type { Api } from './api.js';
import type { CivilianTransport } from './channels.js';
import type { Log } from './incidents.js';

/** Whether a text asks for a new evacuation route. */
export type RouteAsk = (text: string) => Promise<boolean>;

export const REROUTE_BY = 'operator-agent:reroute';
const MODEL = 'claude-haiku-4-5';
/** The api's limit on paths one plan keeps off. */
const MAX_AVOID = 20;
const SYSTEM = `You read text messages sent to Ember, a wildfire alert service, by the operator who receives its evacuation route alerts.
Decide whether the message asks for a new, updated or different evacuation route or path: for example "new route", "send an updated path", "that road is blocked, another way out?". Greetings, thanks, questions about anything else, and messages that only acknowledge an alert are not route requests.`;

const digits = (phone: string) => phone.replace(/\D/g, '');
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Asks Claude Haiku to classify the text; any failure counts as not a route request. */
export function haikuRouteAsk(client: Anthropic, log: Log): RouteAsk {
    return async (text) => {
        try {
            const response = await client.messages.create({
                model: MODEL,
                max_tokens: 256,
                system: SYSTEM,
                messages: [{ role: 'user', content: text }],
                output_config: {
                    format: {
                        type: 'json_schema',
                        schema: {
                            type: 'object',
                            properties: { newRoute: { type: 'boolean' } },
                            required: ['newRoute'],
                            additionalProperties: false,
                        },
                    },
                },
            });
            const block = response.content.find((b) => b.type === 'text');
            if (response.stop_reason !== 'end_turn' || !block) return false;
            return (JSON.parse(block.text) as { newRoute: boolean }).newRoute === true;
        } catch (err) {
            log.warn({ err: errorText(err) }, 'route request not classified');
            return false;
        }
    };
}

export type RerouteDeps = {
    api: Api;
    transport: CivilianTransport;
    /** E.164; only texts from this phone are read. */
    phone: string;
    wantsNewRoute: RouteAsk;
    log: Log;
};

/**
 * Turns the notify phone's "new route" texts into one fresh plan, for the burning zone whose route
 * was texted last, kept off that route so it finds the most different way out. The plan's text and
 * map then go out like any other through `Notices`, once the planner succeeds.
 */
export class Reroute {
    constructor(private readonly deps: RerouteDeps) {}

    async handle(from: string, text: string): Promise<void> {
        const { api, transport, phone, wantsNewRoute, log } = this.deps;
        if (digits(from) !== digits(phone)) {
            log.info({ from }, 'text from a number other than the notify phone: ignored');
            return;
        }
        if (!text.trim() || !(await wantsNewRoute(text))) return;

        const zones = await api.zones();
        const burning = (
            await Promise.all(
                zones.map(async (zone) => {
                    const view = await api.riskZones(zone.id);
                    return view.riskZones.some((r) => r.risk === 'on_fire') ? zone : null;
                }),
            )
        ).filter((z) => z !== null);
        if (!burning.length) {
            await transport.send(
                phone,
                'Ember: no fire is burning now, so there is no route to plan.',
            );
            log.info({}, 'new route asked with no fire burning');
            return;
        }
        // One new route, for the zone whose plan was texted last: the newest that succeeded.
        const looks = await Promise.all(
            burning.map(async (zone) => {
                const jobs = await api.plannerJobs(zone.id);
                const done =
                    jobs
                        .filter((j) => j.state === 'succeeded')
                        .toSorted((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0] ?? null;
                return { zone, jobs, done };
            }),
        );
        if (
            looks.some(({ jobs }) =>
                jobs.some(
                    (j) =>
                        j.requestedBy === REROUTE_BY &&
                        j.state !== 'succeeded' &&
                        j.state !== 'failed',
                ),
            )
        ) {
            log.info({}, 'new route asked: one is already being planned');
            return;
        }
        const { zone, done } =
            looks
                .filter((l) => l.done)
                .toSorted((a, b) => b.done!.requestedAt.localeCompare(a.done!.requestedAt))[0] ??
            looks[0]!;
        const avoidPaths = done ? await this.avoidPaths(done.jobId) : [];
        const job = await api.requestPlan(
            zone.id,
            REROUTE_BY,
            avoidPaths.length ? { avoidPaths } : undefined,
        );
        log.info(
            { zoneId: zone.id, jobId: job.jobId, avoided: avoidPaths.length },
            'new route asked: plan requested',
        );
    }

    /**
     * The routes the new one keeps off: the one last texted, and any that plan already kept off,
     * so each ask finds a way out unlike every route sent before it.
     */
    private async avoidPaths(jobId: string): Promise<LatLng[][]> {
        const job = await this.deps.api.plannerJob(jobId);
        const before = job.options?.avoidPaths ?? [];
        const route = job.result ? usable(leadEvacuation(job.result)?.route ?? null) : null;
        return [...before, ...(route ? [route.path] : [])].slice(-MAX_AVOID);
    }
}
