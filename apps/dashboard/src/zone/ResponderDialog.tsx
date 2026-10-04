import {
    RESPONDER_PAIRING_KIND,
    type ResponderPairingCode,
    type WatchZoneId,
} from '@ember/contracts';
import { AnimatePresence, motion } from 'motion/react';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons/Icon';
import { joinResponder } from '../sim/actions';
import { hex } from '../sim/world';
import type { WatchZone } from '../sim/types';
import { useUi } from '../store/ui';
import { Button } from '../ui/Button';
import { ago } from '../ui/format';
import { Modal } from '../ui/Modal';
import panel from '../ui/panel.module.css';
import { useNow } from '../ui/useNow';
import styles from './ResponderDialog.module.css';

const CODE_MS = 10 * 60 * 1000;
// The console runs on dummy data; this is where services/api listens by default.
const API_URL = 'http://localhost:4001';

function pairingCode(zone: WatchZone): ResponderPairingCode {
    return {
        kind: RESPONDER_PAIRING_KIND,
        v: 1,
        apiUrl: API_URL,
        zoneId: zone.id as WatchZoneId,
        zoneName: zone.name,
        token: hex(Math.random, 24),
        expiresAt: new Date(Date.now() + CODE_MS).toISOString(),
    };
}

export function ResponderDialog({ zone }: { zone: WatchZone }) {
    const open = useUi((s) => s.responderOpen);
    const setOpen = useUi((s) => s.setResponderOpen);
    const [code, setCode] = useState<ResponderPairingCode | null>(null);
    const [svg, setSvg] = useState('');
    const now = useNow(1000);
    const latest = useRef(zone);
    latest.current = zone;

    useEffect(() => {
        if (open) setCode(pairingCode(latest.current));
    }, [open, zone.id]);

    useEffect(() => {
        if (!code) return;
        let live = true;
        void QRCode.toString(JSON.stringify(code), {
            type: 'svg',
            margin: 0,
            // M keeps the code at 57 modules so a phone reads it off a monitor; nothing covers it.
            errorCorrectionLevel: 'M',
            color: { dark: '#1C1714', light: '#00000000' },
        }).then((s) => live && setSvg(s));
        return () => {
            live = false;
        };
    }, [code]);

    useEffect(() => {
        if (!open) return;
        // In the demo, someone in the field scans the code a few seconds after it appears.
        const join = window.setTimeout(() => joinResponder(zone.id), 6500);
        return () => window.clearTimeout(join);
    }, [open, zone.id]);

    const left = code ? Math.max(0, Date.parse(code.expiresAt) - now) : CODE_MS;
    const mm = Math.floor(left / 60_000);
    const ss = Math.floor((left % 60_000) / 1000)
        .toString()
        .padStart(2, '0');

    return (
        <Modal
            open={open}
            onClose={() => setOpen(false)}
            title="Connect a responder"
            subtitle={`Scan with the Ember Responder app to join ${zone.name}.`}
            icon="qr"
            width={680}
        >
            <div className={styles.layout}>
                <div className={styles.codeSide}>
                    <div className={styles.qrFrame}>
                        <AnimatePresence mode="wait">
                            <motion.div
                                key={code?.token}
                                className={styles.qr}
                                initial={{ opacity: 0, scale: 0.9, filter: 'blur(6px)' }}
                                animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                                exit={{ opacity: 0, scale: 1.04, filter: 'blur(6px)' }}
                                transition={{ duration: 0.35 }}
                                dangerouslySetInnerHTML={{ __html: svg }}
                            />
                        </AnimatePresence>
                    </div>
                    <div className={styles.expiry}>
                        <span className="mono">
                            {left > 0 ? `Expires in ${mm}:${ss}` : 'Expired'}
                        </span>
                        <div className={panel.bar}>
                            <motion.span
                                className={panel.barFill}
                                animate={{ width: `${(left / CODE_MS) * 100}%` }}
                                transition={{ duration: 0.5 }}
                            />
                        </div>
                    </div>
                    <Button size="sm" icon="refresh" onClick={() => setCode(pairingCode(zone))}>
                        New code
                    </Button>
                </div>

                <div className={styles.infoSide}>
                    <ol className={styles.steps}>
                        <li>
                            <span>1</span>
                            <p>
                                Open <b>Ember Responder</b>.
                            </p>
                        </li>
                        <li>
                            <span>2</span>
                            <p>Point the camera at this code.</p>
                        </li>
                        <li>
                            <span>3</span>
                            <p>The zone map downloads for offline use, then syncs live.</p>
                        </li>
                    </ol>
                    <div className={panel.sectionTitle} style={{ margin: '18px 0 10px' }}>
                        <Icon name="shield" size={13} /> Connected · {zone.responders.length}
                    </div>
                    <ul className={panel.list}>
                        <AnimatePresence initial={false}>
                            {[...zone.responders].reverse().map((r) => (
                                <motion.li
                                    key={r.id}
                                    layout
                                    className={panel.item}
                                    initial={{ opacity: 0, scale: 0.85, y: -10 }}
                                    animate={{ opacity: 1, scale: 1, y: 0 }}
                                    transition={{ type: 'spring', stiffness: 420, damping: 26 }}
                                >
                                    <span className={panel.itemIcon} data-tone="ink">
                                        <Icon name="user" size={15} />
                                    </span>
                                    <span className={panel.itemText}>
                                        <strong>{r.name}</strong>
                                        <span>
                                            {r.unit} · {r.device}
                                        </span>
                                    </span>
                                    <span
                                        className={panel.tag}
                                        data-tone={now - r.joinedAt < 15_000 ? 'flame' : 'ok'}
                                    >
                                        {now - r.joinedAt < 15_000
                                            ? 'Just joined'
                                            : ago(r.joinedAt, now)}
                                    </span>
                                </motion.li>
                            ))}
                        </AnimatePresence>
                        {zone.responders.length === 0 ? (
                            <li className={panel.muted}>Waiting for the first scan…</li>
                        ) : null}
                    </ul>
                </div>
            </div>
        </Modal>
    );
}
