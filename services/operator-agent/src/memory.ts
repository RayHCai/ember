import { Pool } from 'pg';
import type { Decision } from '@ember/contracts';

export type ChatTurn = { role: 'user' | 'agent'; text: string; at: string };

/**
 * Work the agent started and finishes later: a planner job whose result triggers the next step.
 * `kind` names the playbook continuation; `data` is what it needs.
 */
export type Pending = {
    jobId: string;
    zoneId: string;
    kind: 'risk' | 'escalation' | 'replan';
    incidentId: string | null;
    data: Record<string, string>;
    createdAt: string;
};

/** operator-agent's own state. The api is the record; this is working memory only. */
export interface AgentMemory {
    addDecision(d: Omit<Decision, 'id' | 'number' | 'at'>, at: string): Promise<Decision>;
    decision(idOrNumber: string): Promise<Decision | null>;
    decisions(filter: {
        zoneId?: string;
        incidentId?: string;
        limit?: number;
    }): Promise<Decision[]>;
    appendTurn(sessionId: string, turn: ChatTurn): Promise<void>;
    turns(sessionId: string, limit: number): Promise<ChatTurn[]>;
    /** Per-civilian notes the agent keeps from conversations, newest last. */
    addCivilianNote(civilianId: string, note: string, at: string): Promise<void>;
    civilianNotes(civilianId: string): Promise<string[]>;
    addPending(p: Pending): Promise<void>;
    pending(): Promise<Pending[]>;
    removePending(jobId: string): Promise<void>;
    /** Small loop state: cursors and last-seen values, as JSON. */
    getState<T>(key: string): Promise<T | null>;
    setState(key: string, value: unknown): Promise<void>;
}

export class InMemory implements AgentMemory {
    private readonly log: Decision[] = [];
    private readonly chats = new Map<string, ChatTurn[]>();
    private readonly notes = new Map<string, string[]>();
    private readonly work = new Map<string, Pending>();
    private readonly state = new Map<string, unknown>();

    async addDecision(d: Omit<Decision, 'id' | 'number' | 'at'>, at: string) {
        const decision: Decision = {
            ...d,
            id: crypto.randomUUID(),
            number: this.log.length + 1,
            at,
        };
        this.log.push(decision);
        return structuredClone(decision);
    }

    async decision(idOrNumber: string) {
        const found = this.log.find((d) => d.id === idOrNumber || String(d.number) === idOrNumber);
        return found ? structuredClone(found) : null;
    }

    async decisions(filter: { zoneId?: string; incidentId?: string; limit?: number }) {
        return this.log
            .filter(
                (d) =>
                    (!filter.zoneId || d.zoneId === filter.zoneId) &&
                    (!filter.incidentId || d.incidentId === filter.incidentId),
            )
            .slice(-(filter.limit ?? 50))
            .toReversed()
            .map((d) => structuredClone(d));
    }

    async appendTurn(sessionId: string, turn: ChatTurn) {
        this.chats.set(sessionId, [...(this.chats.get(sessionId) ?? []), turn]);
    }

    async turns(sessionId: string, limit: number) {
        return (this.chats.get(sessionId) ?? []).slice(-limit);
    }

    async addCivilianNote(civilianId: string, note: string) {
        this.notes.set(civilianId, [...(this.notes.get(civilianId) ?? []), note]);
    }

    async civilianNotes(civilianId: string) {
        return this.notes.get(civilianId) ?? [];
    }

    async addPending(p: Pending) {
        this.work.set(p.jobId, p);
    }

    async pending() {
        return [...this.work.values()];
    }

    async removePending(jobId: string) {
        this.work.delete(jobId);
    }

    async getState<T>(key: string) {
        return (this.state.get(key) as T | undefined) ?? null;
    }

    async setState(key: string, value: unknown) {
        this.state.set(key, structuredClone(value));
    }
}

const SCHEMA = `
CREATE SCHEMA IF NOT EXISTS operator_agent;
CREATE TABLE IF NOT EXISTS operator_agent.decisions (
    number serial PRIMARY KEY,
    id uuid NOT NULL UNIQUE,
    zone_id text,
    incident_id text,
    at timestamptz NOT NULL,
    doc jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_zone_idx ON operator_agent.decisions (zone_id);
CREATE INDEX IF NOT EXISTS decisions_incident_idx ON operator_agent.decisions (incident_id);
CREATE TABLE IF NOT EXISTS operator_agent.chat_turns (
    id bigserial PRIMARY KEY,
    session_id text NOT NULL,
    role text NOT NULL,
    text text NOT NULL,
    at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_turns_session_idx ON operator_agent.chat_turns (session_id, id);
CREATE TABLE IF NOT EXISTS operator_agent.civilian_notes (
    id bigserial PRIMARY KEY,
    civilian_id text NOT NULL,
    note text NOT NULL,
    at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS civilian_notes_idx ON operator_agent.civilian_notes (civilian_id, id);
CREATE TABLE IF NOT EXISTS operator_agent.pending (
    job_id text PRIMARY KEY,
    doc jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS operator_agent.state (
    key text PRIMARY KEY,
    value jsonb NOT NULL
);
`;

/** The `operator_agent` schema in Postgres; created on start, no other service reads it. */
export class PgMemory implements AgentMemory {
    constructor(private readonly pool: Pool) {}

    static async connect(url: string): Promise<PgMemory> {
        const pool = new Pool({ connectionString: url, max: 5 });
        await pool.query(SCHEMA);
        return new PgMemory(pool);
    }

    close() {
        return this.pool.end();
    }

    async addDecision(d: Omit<Decision, 'id' | 'number' | 'at'>, at: string) {
        const id = crypto.randomUUID();
        const { rows } = await this.pool.query<{ number: number }>(
            `INSERT INTO operator_agent.decisions (id, zone_id, incident_id, at, doc)
             VALUES ($1, $2, $3, $4, $5) RETURNING number`,
            [id, d.zoneId, d.incidentId, at, JSON.stringify(d)],
        );
        return { ...d, id, number: rows[0]!.number, at };
    }

    private row(r: {
        id: string;
        number: number;
        at: Date;
        doc: Omit<Decision, 'id' | 'number' | 'at'>;
    }) {
        return { ...r.doc, id: r.id, number: r.number, at: r.at.toISOString() };
    }

    async decision(idOrNumber: string) {
        const byNumber = /^\d+$/.test(idOrNumber);
        const { rows } = await this.pool.query(
            `SELECT id, number, at, doc FROM operator_agent.decisions WHERE ${byNumber ? 'number = $1' : 'id::text = $1'}`,
            [byNumber ? Number(idOrNumber) : idOrNumber],
        );
        return rows[0] ? this.row(rows[0]) : null;
    }

    async decisions(filter: { zoneId?: string; incidentId?: string; limit?: number }) {
        const { rows } = await this.pool.query(
            `SELECT id, number, at, doc FROM operator_agent.decisions
             WHERE ($1::text IS NULL OR zone_id = $1) AND ($2::text IS NULL OR incident_id = $2)
             ORDER BY number DESC LIMIT $3`,
            [filter.zoneId ?? null, filter.incidentId ?? null, filter.limit ?? 50],
        );
        return rows.map((r) => this.row(r));
    }

    async appendTurn(sessionId: string, turn: ChatTurn) {
        await this.pool.query(
            'INSERT INTO operator_agent.chat_turns (session_id, role, text, at) VALUES ($1, $2, $3, $4)',
            [sessionId, turn.role, turn.text, turn.at],
        );
    }

    async turns(sessionId: string, limit: number) {
        const { rows } = await this.pool.query<{ role: ChatTurn['role']; text: string; at: Date }>(
            `SELECT role, text, at FROM operator_agent.chat_turns WHERE session_id = $1
             ORDER BY id DESC LIMIT $2`,
            [sessionId, limit],
        );
        return rows
            .toReversed()
            .map((r) => ({ role: r.role, text: r.text, at: r.at.toISOString() }));
    }

    async addCivilianNote(civilianId: string, note: string, at: string) {
        await this.pool.query(
            'INSERT INTO operator_agent.civilian_notes (civilian_id, note, at) VALUES ($1, $2, $3)',
            [civilianId, note, at],
        );
    }

    async civilianNotes(civilianId: string) {
        const { rows } = await this.pool.query<{ note: string }>(
            'SELECT note FROM operator_agent.civilian_notes WHERE civilian_id = $1 ORDER BY id',
            [civilianId],
        );
        return rows.map((r) => r.note);
    }

    async addPending(p: Pending) {
        await this.pool.query(
            `INSERT INTO operator_agent.pending (job_id, doc) VALUES ($1, $2)
             ON CONFLICT (job_id) DO UPDATE SET doc = EXCLUDED.doc`,
            [p.jobId, JSON.stringify(p)],
        );
    }

    async pending() {
        const { rows } = await this.pool.query<{ doc: Pending }>(
            'SELECT doc FROM operator_agent.pending',
        );
        return rows.map((r) => r.doc);
    }

    async removePending(jobId: string) {
        await this.pool.query('DELETE FROM operator_agent.pending WHERE job_id = $1', [jobId]);
    }

    async getState<T>(key: string) {
        const { rows } = await this.pool.query<{ value: T }>(
            'SELECT value FROM operator_agent.state WHERE key = $1',
            [key],
        );
        return rows[0]?.value ?? null;
    }

    async setState(key: string, value: unknown) {
        await this.pool.query(
            `INSERT INTO operator_agent.state (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
            [key, JSON.stringify(value)],
        );
    }
}
