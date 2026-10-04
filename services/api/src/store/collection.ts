export type Scalar = string | number | boolean | null;

/** Equality on top-level scalar fields. */
export type Where<T> = { [K in keyof T]?: Extract<T[K], Scalar> };

export type ListOptions<T> = { orderBy?: keyof T & string; desc?: boolean; limit?: number };

/** One kind of record, keyed by one of its fields. */
export interface Collection<T extends object> {
    get(id: string): Promise<T | null>;
    /** Resolves false when a record with that key exists already. */
    insert(doc: T): Promise<boolean>;
    put(doc: T): Promise<void>;
    list(where?: Where<T>, options?: ListOptions<T>): Promise<T[]>;
    remove(id: string): Promise<void>;
}

export interface Counters {
    /** 1, 2, 3, ... per name. */
    next(name: string): Promise<number>;
}

function compare(a: unknown, b: unknown): number {
    if (a === b) return 0;
    if (a === null || a === undefined) return -1;
    if (b === null || b === undefined) return 1;
    return (a as number | string) < (b as number | string) ? -1 : 1;
}

export class MemoryCollection<T extends object> implements Collection<T> {
    private readonly docs = new Map<string, T>();

    constructor(private readonly key: keyof T & string) {}

    private id(doc: T): string {
        return String(doc[this.key]);
    }

    async get(id: string) {
        const doc = this.docs.get(id);
        return doc ? structuredClone(doc) : null;
    }

    async insert(doc: T) {
        if (this.docs.has(this.id(doc))) return false;
        this.docs.set(this.id(doc), structuredClone(doc));
        return true;
    }

    async put(doc: T) {
        this.docs.set(this.id(doc), structuredClone(doc));
    }

    async list(where: Where<T> = {}, options: ListOptions<T> = {}) {
        const conditions = Object.entries(where) as [keyof T, Scalar][];
        let out = [...this.docs.values()].filter((d) =>
            conditions.every(([k, v]) => (d[k] ?? null) === v),
        );
        const { orderBy } = options;
        if (orderBy) {
            out.sort((a, b) => compare(a[orderBy], b[orderBy]) * (options.desc ? -1 : 1));
        }
        if (options.limit !== undefined) out = out.slice(0, options.limit);
        return out.map((d) => structuredClone(d));
    }

    async remove(id: string) {
        this.docs.delete(id);
    }
}

export class MemoryCounters implements Counters {
    private readonly values = new Map<string, number>();

    async next(name: string) {
        const value = (this.values.get(name) ?? 0) + 1;
        this.values.set(name, value);
        return value;
    }
}

/** What the SQL collections need from a database: parameterised queries returning rows. */
export interface Sql {
    query<R>(text: string, params: unknown[]): Promise<R[]>;
}

const FIELD = /^[A-Za-z][A-Za-z0-9]*$/;

function field(name: string): string {
    if (!FIELD.test(name)) throw new Error(`invalid field name ${name}`);
    return `'${name}'`;
}

/**
 * A table `(id text primary key, zone_id text, doc jsonb, created_at timestamptz)`. Lists filter
 * on jsonb fields, so they suit the hundreds of records a zone holds, not bulk history.
 */
export class SqlCollection<T extends object> implements Collection<T> {
    constructor(
        private readonly sql: Sql,
        private readonly table: string,
        private readonly key: keyof T & string,
        private readonly zoneField: (keyof T & string) | null,
    ) {
        if (!/^[a-z_]+$/.test(table)) throw new Error(`invalid table ${table}`);
    }

    private zone(doc: T): string | null {
        if (!this.zoneField) return null;
        const v = doc[this.zoneField];
        return v === null || v === undefined ? null : String(v);
    }

    async get(id: string) {
        const rows = await this.sql.query<{ doc: T }>(
            `SELECT doc FROM ${this.table} WHERE id = $1`,
            [id],
        );
        return rows[0]?.doc ?? null;
    }

    async insert(doc: T) {
        const rows = await this.sql.query<{ id: string }>(
            `INSERT INTO ${this.table} (id, zone_id, doc) VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (id) DO NOTHING RETURNING id`,
            [String(doc[this.key]), this.zone(doc), JSON.stringify(doc)],
        );
        return rows.length > 0;
    }

    async put(doc: T) {
        await this.sql.query(
            `INSERT INTO ${this.table} (id, zone_id, doc) VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (id) DO UPDATE SET zone_id = EXCLUDED.zone_id, doc = EXCLUDED.doc
             RETURNING id`,
            [String(doc[this.key]), this.zone(doc), JSON.stringify(doc)],
        );
    }

    async list(where: Where<T> = {}, options: ListOptions<T> = {}) {
        const params: unknown[] = [];
        const clauses = (Object.entries(where) as [string, Scalar][]).map(([k, v]) => {
            if (k === this.zoneField && v !== null) {
                params.push(String(v));
                return `zone_id = $${params.length}`;
            }
            params.push(JSON.stringify(v));
            return `coalesce(doc->${field(k)}, 'null'::jsonb) = $${params.length}::jsonb`;
        });
        let text = `SELECT doc FROM ${this.table}`;
        if (clauses.length) text += ` WHERE ${clauses.join(' AND ')}`;
        text += options.orderBy
            ? ` ORDER BY doc->${field(options.orderBy)} ${options.desc ? 'DESC' : 'ASC'}`
            : ' ORDER BY created_at ASC';
        if (options.limit !== undefined) {
            params.push(options.limit);
            text += ` LIMIT $${params.length}`;
        }
        return (await this.sql.query<{ doc: T }>(text, params)).map((r) => r.doc);
    }

    async remove(id: string) {
        await this.sql.query(`DELETE FROM ${this.table} WHERE id = $1 RETURNING id`, [id]);
    }
}

export class SqlCounters implements Counters {
    constructor(private readonly sql: Sql) {}

    async next(name: string) {
        const rows = await this.sql.query<{ value: number }>(
            `INSERT INTO counters (name, value) VALUES ($1, 1)
             ON CONFLICT (name) DO UPDATE SET value = counters.value + 1 RETURNING value`,
            [name],
        );
        return Number(rows[0]!.value);
    }
}
