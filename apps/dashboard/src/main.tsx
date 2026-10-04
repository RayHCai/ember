import '@fontsource/atkinson-hyperlegible/latin-400.css';
import '@fontsource/atkinson-hyperlegible/latin-700.css';
import '@fontsource/gloock/latin-400.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import markUrl from '../../../assets/brand/icon.svg';
import { App } from './App';
import { useMap } from './map/viewer';
import { forwardErrorsToAppLog, markShell } from './shell';
import { useNotices } from './store/notifications';
import { useRouter } from './store/router';
import { useSession } from './store/session';
import { useUi } from './store/ui';
import { useZones } from './store/zones';
import './styles/theme.css';

// Linked here, not in index.html: a path outside the app root only resolves through the module graph.
document.head.append(
    Object.assign(document.createElement('link'), {
        rel: 'icon',
        type: 'image/svg+xml',
        href: markUrl,
    }),
);
markShell();
forwardErrorsToAppLog();
// Development only: state stores for debugging and browser tests.
if (import.meta.env.DEV) {
    Object.assign(window, {
        __ember: { useZones, useUi, useSession, useRouter, useNotices, useMap },
    });
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
