import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../icons/Icon';
import { sendBlast, subscribedCivilians } from '../sim/actions';
import type { Blast, BlastAudience, BlastPriority, WatchZone } from '../sim/types';
import { notify } from '../store/notifications';
import { useSession } from '../store/session';
import { useUi, type BlastDraft } from '../store/ui';
import { Button } from '../ui/Button';
import { ago, clock } from '../ui/format';
import { Modal } from '../ui/Modal';
import panel from '../ui/panel.module.css';
import { Segmented } from '../ui/Segmented';
import ui from '../ui/ui.module.css';
import { useNow } from '../ui/useNow';
import styles from './BlastDialog.module.css';
import { HoldButton } from './HoldButton';

type Step = 'compose' | 'approve' | 'sent';

const TEMPLATES: { label: string; draft: Omit<BlastDraft, 'audience' | 'area'> }[] = [
    {
        label: 'Evacuate now',
        draft: {
            priority: 'critical',
            title: 'Evacuate now',
            body: 'Ember alert: a wildfire is moving toward your area. Leave now by the marked route. Reply SAFE once you are out.',
        },
    },
    {
        label: 'Get ready',
        draft: {
            priority: 'urgent',
            title: 'Be ready to leave',
            body: 'Ember alert: a wildfire is burning nearby. Pack essentials, keep your car fueled, and watch for an evacuation order.',
        },
    },
    {
        label: 'Update',
        draft: {
            priority: 'routine',
            title: 'Fire update',
            body: 'Ember update: crews and drones are working the fire. No action needed right now. Reply with any questions.',
        },
    },
    {
        label: 'All clear',
        draft: {
            priority: 'routine',
            title: 'All clear',
            body: 'Ember update: the fire is contained and the evacuation order is lifted. Thank you for checking in.',
        },
    },
];

const EMPTY: BlastDraft = {
    audience: 'both',
    priority: 'urgent',
    title: '',
    body: '',
    area: 'zone',
};

function Burst() {
    const pieces = useMemo(
        () =>
            Array.from({ length: 16 }, (_, i) => ({
                angle: (i / 16) * Math.PI * 2,
                dist: 70 + (i % 3) * 22,
                color: ['#FFB347', '#FF6A2B', '#E2341D', '#1F9D6B'][i % 4]!,
            })),
        [],
    );
    return (
        <div className={styles.burst} aria-hidden>
            {pieces.map((p, i) => (
                <motion.svg
                    key={i}
                    width="12"
                    height="12"
                    viewBox="0 0 10 10"
                    initial={{ x: 0, y: 0, opacity: 1, scale: 0.4, rotate: 0 }}
                    animate={{
                        x: Math.cos(p.angle) * p.dist,
                        y: Math.sin(p.angle) * p.dist,
                        opacity: 0,
                        scale: 1,
                        rotate: 260,
                    }}
                    transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1], delay: 0.1 }}
                >
                    <polygon points="5,0 10,8 0,9" fill={p.color} />
                </motion.svg>
            ))}
        </div>
    );
}

export function BlastDialog({ zone }: { zone: WatchZone }) {
    const state = useUi((s) => s.blast);
    const close = useUi((s) => s.closeBlast);
    const operator = useSession((s) => s.session?.name ?? 'Operator');
    const [draft, setDraft] = useState<BlastDraft>(EMPTY);
    const [step, setStep] = useState<Step>('compose');
    const [sent, setSent] = useState<Blast | null>(null);
    const [approvedAt, setApprovedAt] = useState<number | null>(null);
    const now = useNow(10_000);

    useEffect(() => {
        if (!state) return;
        const initial = state.draft ?? EMPTY;
        setDraft(initial);
        setSent(null);
        setApprovedAt(null);
        setStep(
            state.approve && initial.audience !== 'responders' && initial.body
                ? 'approve'
                : 'compose',
        );
    }, [state]);

    const civilians = draft.audience !== 'responders';
    const responders = draft.audience !== 'civilians';
    const civilianCount = civilians ? subscribedCivilians(zone.id, draft.area) : 0;
    const responderCount = responders ? zone.responders.length : 0;
    const segments = Math.max(1, Math.ceil(draft.body.length / 160));
    const ready = draft.title.trim() && draft.body.trim();
    const patch = (p: Partial<BlastDraft>) => setDraft((d) => ({ ...d, ...p }));

    const deliver = (approval: { approvedBy: string; approvedAt: number } | null) => {
        try {
            setSent(sendBlast(zone.id, draft, approval));
            setStep('sent');
        } catch (err) {
            notify(
                'critical',
                'Blast not sent',
                err instanceof Error ? err.message : String(err),
                zone,
            );
        }
    };

    return (
        <Modal
            open={state !== null}
            onClose={close}
            title={
                step === 'approve'
                    ? 'Approve civilian alert'
                    : step === 'sent'
                      ? 'Blast sent'
                      : 'Event blast'
            }
            subtitle={
                step === 'compose'
                    ? `Send status to civilians, responders, or both in ${zone.name}.`
                    : undefined
            }
            icon={step === 'approve' ? 'shield' : 'megaphone'}
            width={step === 'compose' ? 760 : 560}
        >
            <AnimatePresence mode="wait" initial={false}>
                {step === 'compose' ? (
                    <motion.div
                        key="compose"
                        className={styles.compose}
                        initial={{ opacity: 0, x: -16 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -16 }}
                    >
                        <div className={styles.form}>
                            <div className={ui.field}>
                                <span className={ui.fieldLabel}>Send to</span>
                                <Segmented<BlastAudience>
                                    label="Audience"
                                    value={draft.audience}
                                    onChange={(audience) => patch({ audience })}
                                    options={[
                                        { value: 'civilians', label: 'Civilians', icon: 'users' },
                                        {
                                            value: 'responders',
                                            label: 'Responders',
                                            icon: 'shield',
                                        },
                                        { value: 'both', label: 'Both', icon: 'megaphone' },
                                    ]}
                                />
                            </div>
                            <div className={styles.twoUp}>
                                <div className={ui.field}>
                                    <span className={ui.fieldLabel}>Priority</span>
                                    <Segmented<BlastPriority>
                                        label="Priority"
                                        value={draft.priority}
                                        onChange={(priority) => patch({ priority })}
                                        options={[
                                            { value: 'routine', label: 'Routine' },
                                            { value: 'urgent', label: 'Urgent' },
                                            { value: 'critical', label: 'Critical' },
                                        ]}
                                    />
                                </div>
                                <div className={ui.field}>
                                    <span className={ui.fieldLabel}>Area</span>
                                    <Segmented<BlastDraft['area']>
                                        label="Area"
                                        value={draft.area}
                                        onChange={(area) => patch({ area })}
                                        options={[
                                            { value: 'zone', label: 'Whole zone' },
                                            { value: 'near_fire', label: 'Near fire' },
                                        ]}
                                    />
                                </div>
                            </div>
                            <div className={styles.templates}>
                                {TEMPLATES.map((t) => (
                                    <button
                                        key={t.label}
                                        type="button"
                                        onClick={() => patch(t.draft)}
                                    >
                                        {t.label}
                                    </button>
                                ))}
                            </div>
                            <label className={ui.field}>
                                <span className={ui.fieldLabel}>Title</span>
                                <input
                                    className={ui.input}
                                    value={draft.title}
                                    onChange={(e) => patch({ title: e.target.value })}
                                    placeholder="What is happening"
                                />
                            </label>
                            <label className={ui.field}>
                                <span className={ui.fieldLabel}>
                                    Message{' '}
                                    <em className={styles.count}>
                                        {draft.body.length} chars · {segments} SMS
                                    </em>
                                </span>
                                <textarea
                                    className={ui.input}
                                    value={draft.body}
                                    onChange={(e) => patch({ body: e.target.value })}
                                    placeholder="What people should do, and where to go"
                                />
                            </label>
                        </div>

                        <div className={styles.preview}>
                            <div className={styles.phone}>
                                <span className={styles.notch} />
                                <span className={styles.phoneTime}>{clock(now)}</span>
                                <AnimatePresence mode="popLayout">
                                    {civilians ? (
                                        <motion.div
                                            key="sms"
                                            layout
                                            className={styles.sms}
                                            initial={{ opacity: 0, y: 10 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            exit={{ opacity: 0 }}
                                        >
                                            <span className={styles.from}>Ember · SMS</span>
                                            <p>
                                                <b>{draft.title || 'Title'}</b>{' '}
                                                {draft.body || 'Your message shows here.'}
                                            </p>
                                        </motion.div>
                                    ) : null}
                                    {responders ? (
                                        <motion.div
                                            key="push"
                                            layout
                                            className={styles.push}
                                            initial={{ opacity: 0, y: -10 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            exit={{ opacity: 0 }}
                                        >
                                            <span className={styles.from}>
                                                <Icon name="flame" size={11} /> Ember Responder ·
                                                now
                                            </span>
                                            <b>{draft.title || 'Title'}</b>
                                            <span>{draft.body || 'Your message shows here.'}</span>
                                        </motion.div>
                                    ) : null}
                                </AnimatePresence>
                            </div>
                            <div className={styles.recipients}>
                                {civilians ? (
                                    <span>
                                        <Icon name="users" size={13} /> ~{civilianCount} civilians
                                    </span>
                                ) : null}
                                {responders ? (
                                    <span>
                                        <Icon name="shield" size={13} /> {responderCount} responders
                                    </span>
                                ) : null}
                            </div>
                        </div>

                        <div className={styles.footer}>
                            {zone.blasts[0] ? (
                                <span className={panel.muted}>
                                    Last blast “{zone.blasts[0].title}” {ago(zone.blasts[0].sentAt)}
                                </span>
                            ) : (
                                <span />
                            )}
                            {civilians ? (
                                <Button
                                    variant="primary"
                                    iconAfter="arrowRight"
                                    disabled={!ready}
                                    onClick={() => setStep('approve')}
                                >
                                    Review for approval
                                </Button>
                            ) : (
                                <Button
                                    variant="primary"
                                    icon="send"
                                    disabled={!ready || responderCount === 0}
                                    onClick={() => deliver(null)}
                                >
                                    Send to {responderCount} responders
                                </Button>
                            )}
                        </div>
                    </motion.div>
                ) : step === 'approve' ? (
                    <motion.div
                        key="approve"
                        className={panel.stack}
                        initial={{ opacity: 0, x: 16 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -16 }}
                    >
                        <div className={styles.summary}>
                            <div className={panel.row} style={{ flexWrap: 'wrap' }}>
                                <span
                                    className={panel.tag}
                                    data-tone={
                                        draft.priority === 'critical'
                                            ? 'fire'
                                            : draft.priority === 'urgent'
                                              ? 'risk'
                                              : undefined
                                    }
                                >
                                    {draft.priority}
                                </span>
                                <span className={panel.tag}>
                                    {draft.area === 'near_fire'
                                        ? 'Within 2 mi of the fire'
                                        : 'Whole zone'}
                                </span>
                                <span className={panel.tag}>~{civilianCount} civilians</span>
                                {responders ? (
                                    <span className={panel.tag}>{responderCount} responders</span>
                                ) : null}
                            </div>
                            <strong>{draft.title}</strong>
                            <p>{draft.body}</p>
                        </div>
                        <div className={panel.callout}>
                            <Icon name="shield" size={18} />
                            <span>
                                <strong>Civilian alerts need an operator approval</strong>
                                Nothing reaches a civilian's phone without this record. It is saved
                                with the blast.
                            </span>
                        </div>
                        <div className={styles.record}>
                            <span className={panel.muted}>Approval record</span>
                            <span>
                                {approvedAt ? 'Approved' : 'Will be signed'} by <b>{operator}</b> at{' '}
                                {clock(approvedAt ?? now)}
                            </span>
                        </div>
                        <HoldButton
                            label="Hold to approve and send"
                            holdingLabel="Keep holding…"
                            onComplete={() => {
                                const at = Date.now();
                                setApprovedAt(at);
                                deliver({ approvedBy: operator, approvedAt: at });
                            }}
                        />
                        <Button variant="ghost" icon="arrowLeft" onClick={() => setStep('compose')}>
                            Edit message
                        </Button>
                    </motion.div>
                ) : (
                    <motion.div
                        key="sent"
                        className={styles.sent}
                        initial={{ opacity: 0, scale: 0.96 }}
                        animate={{ opacity: 1, scale: 1 }}
                    >
                        <div className={styles.sentMark}>
                            <Burst />
                            <motion.span
                                initial={{ scale: 0, rotate: -45 }}
                                animate={{ scale: 1, rotate: 0 }}
                                transition={{ type: 'spring', stiffness: 400, damping: 14 }}
                            >
                                <Icon name="check" size={34} />
                            </motion.span>
                        </div>
                        <strong>“{sent?.title}” is on its way</strong>
                        <span>
                            {[
                                sent?.recipients.civilians
                                    ? `${sent.recipients.civilians} civilians by SMS and iMessage`
                                    : '',
                                sent?.recipients.responders
                                    ? `${sent.recipients.responders} responders by push`
                                    : '',
                            ]
                                .filter(Boolean)
                                .join(' · ')}
                        </span>
                        {sent?.approval ? (
                            <span className={panel.muted}>
                                Approved by {sent.approval.approvedBy} at{' '}
                                {clock(sent.approval.approvedAt)}
                            </span>
                        ) : null}
                        <Button variant="primary" onClick={close}>
                            Done
                        </Button>
                    </motion.div>
                )}
            </AnimatePresence>
        </Modal>
    );
}
