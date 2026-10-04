import { isTauri } from '@tauri-apps/api/core';

/** True inside the Ember desktop app, false in a plain browser (tests, dev). */
export const inDesktopApp = isTauri();

/** Tags <html> so styles can make room for native window chrome. */
export function markShell(): void {
    document.documentElement.dataset.shell = inDesktopApp ? 'desktop' : 'web';
}

type Level = 'info' | 'warn' | 'error';

/**
 * Writes to the desktop app's log (the terminal in development, the log file
 * in a bundled app). In a browser it does nothing, since the console is there.
 */
export function appLog(level: Level, message: string): void {
    if (!inDesktopApp) return;
    void import('@tauri-apps/plugin-log').then((log) => log[level](message)).catch(() => {});
}

/** Forward uncaught errors from the webview to the app log. */
export function forwardErrorsToAppLog(): void {
    if (!inDesktopApp) return;
    window.addEventListener('error', (e) =>
        appLog('error', `Uncaught: ${e.message} (${e.filename}:${e.lineno})`),
    );
    window.addEventListener('unhandledrejection', (e) =>
        appLog('error', `Unhandled rejection: ${String(e.reason)}`),
    );
    const original = console.error.bind(console);
    console.error = (...args: unknown[]) => {
        original(...args);
        appLog('error', args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
    };
}
