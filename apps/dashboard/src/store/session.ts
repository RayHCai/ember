import type { OperatorSession } from '@ember/contracts';
import { create } from 'zustand';
import { api } from '../api';
import { onUnauthorized, setApiToken } from '../api/client';

// Email and password accounts on the api. The session token is kept on this device and the api
// ends it after a week, so the operator signs in again.

const SESSION_KEY = 'ember.session';
const TIMED_OUT = 'Your session timed out after a week. Sign in again.';

export interface Session {
    token: string;
    operatorId: string;
    name: string;
    email: string;
    expiresAt: number;
}

function read(): Session | null {
    try {
        const raw = window.localStorage.getItem(SESSION_KEY);
        const s = raw ? (JSON.parse(raw) as Partial<Session>) : null;
        return s?.token && s.operatorId && s.expiresAt ? (s as Session) : null;
    } catch {
        return null;
    }
}

function write(session: Session | null): void {
    try {
        if (session) window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        else window.localStorage.removeItem(SESSION_KEY);
    } catch {
        // Storage can be unavailable (private windows); the session then lasts this run only.
    }
}

function fromApi(s: OperatorSession): Session {
    return {
        token: s.token,
        operatorId: s.operator.operatorId,
        name: s.operator.name,
        email: s.operator.email,
        expiresAt: Date.parse(s.expiresAt),
    };
}

interface SessionState {
    session: Session | null;
    /** Why the operator is looking at the sign-in page, if not by choice. */
    notice: string | null;
    signIn: (email: string, password: string) => Promise<void>;
    signUp: (name: string, email: string, password: string) => Promise<void>;
    signOut: (notice?: string) => void;
}

const stored = read();
const initial = stored && stored.expiresAt > Date.now() ? stored : null;
setApiToken(initial?.token ?? null);

export const useSession = create<SessionState>()((set, get) => {
    const start = (s: OperatorSession) => {
        const session = fromApi(s);
        write(session);
        setApiToken(session.token);
        set({ session, notice: null });
    };
    return {
        session: initial,
        notice: stored && !initial ? TIMED_OUT : null,
        signIn: async (email, password) => {
            start(await api.signIn({ email: email.trim().toLowerCase(), password }));
        },
        signUp: async (name, email, password) => {
            start(
                await api.signUp({
                    name: name.trim(),
                    email: email.trim().toLowerCase(),
                    password,
                }),
            );
        },
        signOut: (notice) => {
            if (get().session && !notice) void api.signOut().catch(() => {});
            write(null);
            setApiToken(null);
            set({ session: null, notice: notice ?? null });
        },
    };
});

onUnauthorized(() => {
    if (useSession.getState().session)
        useSession.getState().signOut('Your session ended. Sign in again.');
});

/** Checks a stored session with the api once: a rejected one signs out, an unreachable api keeps it. */
export async function checkSession(): Promise<void> {
    if (useSession.getState().session) await api.session().catch(() => {});
}

/** Signs the operator out the moment the week is up, even mid-shift. */
export function watchSessionExpiry(): () => void {
    let timer = 0;
    const arm = (session: Session | null) => {
        window.clearTimeout(timer);
        if (!session) return;
        timer = window.setTimeout(
            () => useSession.getState().signOut(TIMED_OUT),
            Math.min(2 ** 31 - 1, Math.max(0, session.expiresAt - Date.now())),
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
