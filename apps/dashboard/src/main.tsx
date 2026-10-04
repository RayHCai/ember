import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { forwardErrorsToAppLog, markShell } from './shell';
import { useNotices } from './store/notifications';
import { useRouter } from './store/router';
import { useSession } from './store/session';
import { useUi } from './store/ui';
import { useZones } from './store/zones';
import './styles/theme.css';

markShell();
forwardErrorsToAppLog();
// Development only: state stores for debugging and browser tests.
if (import.meta.env.DEV) {
    Object.assign(window, { __ember: { useZones, useUi, useSession, useRouter, useNotices } });
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
