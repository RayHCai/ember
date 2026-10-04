import { create } from 'zustand';

// Email and password sign-in, kept on this device until the api owns accounts.
// A session lasts a week, then the operator signs in again.

export const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_KEY = 'ember.session';
const ACCOUNTS_KEY = 'ember.accounts';

export const DEMO_ACCOUNT = {
    name: 'Demo operator',
    email: 'operator@ember.dev',
    password: 'wildfire',
};

export interface Session {
    name: string;
    email: string;
    signedInAt: number;
    expiresAt: number;
}

interface Account {
    name: string;
    email: string;
    passwordHash: string;
}

function read<T>(key: string): T | null {
    try {
        const raw = window.localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : null;
    } catch {
        return null;
    }
}

function write(key: string, value: unknown): void {
    try {
        if (value === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Storage can be unavailable (private windows); the session then lasts this run only.
    }
}

async function hashPassword(email: string, password: string): Promise<string> {
    const data = new TextEncoder().encode(`ember:${email}:${password}`);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function accounts(): Promise<Account[]> {
    const stored = read<Account[]>(ACCOUNTS_KEY) ?? [];
    if (stored.some((a) => a.email === DEMO_ACCOUNT.email)) return stored;
    const demo: Account = {
        name: DEMO_ACCOUNT.name,
        email: DEMO_ACCOUNT.email,
        passwordHash: await hashPassword(DEMO_ACCOUNT.email, DEMO_ACCOUNT.password),
    };
    return [demo, ...stored];
}

function startSession(account: Pick<Account, 'name' | 'email'>): Session {
    const now = Date.now();
    const session = {
        name: account.name,
        email: account.email,
        signedInAt: now,
        expiresAt: now + SESSION_MS,
    };
    write(SESSION_KEY, session);
    return session;
}

function storedSession(): Session | null {
    const s = read<Session>(SESSION_KEY);
    return s && s.expiresAt > Date.now() ? s : null;
}

interface SessionState {
    session: Session | null;
    /** Why the operator is looking at the sign-in page, if not by choice. */
    notice: string | null;
    signIn: (email: string, password: string) => Promise<void>;
    signUp: (name: string, email: string, password: string) => Promise<void>;
    signOut: (notice?: string) => void;
}

const initialNotice =
    read<Session>(SESSION_KEY) && !storedSession()
        ? 'Your session timed out after a week. Sign in again.'
        : null;

export const useSession = create<SessionState>()((set) => ({
    session: storedSession(),
    notice: initialNotice,
    signIn: async (rawEmail, password) => {
        const email = rawEmail.trim().toLowerCase();
        const account = (await accounts()).find((a) => a.email === email);
        if (!account) throw new Error('No account uses that email. Create one instead.');
        if (account.passwordHash !== (await hashPassword(email, password)))
            throw new Error('That password is not right.');
        set({ session: startSession(account), notice: null });
    },
    signUp: async (name, rawEmail, password) => {
        const email = rawEmail.trim().toLowerCase();
        const all = await accounts();
        if (all.some((a) => a.email === email))
            throw new Error('An account already uses that email. Sign in instead.');
        const account: Account = {
            name: name.trim(),
            email,
            passwordHash: await hashPassword(email, password),
        };
        write(ACCOUNTS_KEY, [...all, account]);
        set({ session: startSession(account), notice: null });
    },
    signOut: (notice) => {
        write(SESSION_KEY, null);
        set({ session: null, notice: notice ?? null });
    },
}));

/** Signs the operator out the moment the week is up, even mid-shift. */
export function watchSessionExpiry(): () => void {
    let timer = 0;
    const arm = (session: Session | null) => {
        window.clearTimeout(timer);
        if (!session) return;
        timer = window.setTimeout(
            () =>
                useSession
                    .getState()
                    .signOut('Your session timed out after a week. Sign in again.'),
            Math.max(0, session.expiresAt - Date.now()),
        );
    };
    arm(useSession.getState().session);
    const unsubscribe = useSession.subscribe((s, prev) => {
        if (s.session !== prev.session) arm(s.session);
    });
    return () => {
        window.clearTimeout(timer);
        unsubscribe();
    };
}
