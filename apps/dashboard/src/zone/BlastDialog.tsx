import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { Icon } from '../icons/Icon';
import type { Blast, BlastAudience, BlastPriority } from '@ember/contracts';
import type { ZoneView } from '../model/types';
import { approveBlast, createBlast } from '../store/actions';
import { useSession } from '../store/session';
import { useUi, type BlastDraft } from '../store/ui';
import { Button } from '../ui/Button';
import { ago, clock } from '../ui/format';
import { Modal } from '../ui/Modal';
import { QUICK, SMOOTH, SNAP } from '../ui/motion';
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

export function BlastDialog({ zone }: { zone: ZoneView }) {
    const state = useUi((s) => s.blast);
    const close = useUi((s) => s.closeBlast);
    const operator = useSession((s) => s.session?.name ?? 'Operator');
    const [draft, setDraft] = useState<BlastDraft>(EMPTY);
    const [step, setStep] = useState<Step>('compose');
    const [sent, setSent] = useState<Blast | null>(null);
    const [sending, setSending] = useState(false);
    const now = useNow(10_000);
    const pendingId = state?.pendingId ?? null;

    useEffect(() => {
        if (!state) return;
        const initial = state.draft ?? EMPTY;
        setDraft(initial);
        setSent(null);
        setStep(
            state.approve && initial.audience !== 'responders' && initial.body
                ? 'approve'
                : 'compose',
        );
    }, [state]);

    const civilians = draft.audience !== 'responders';
    const responders = draft.audience !== 'civilians';
    const segments = Math.max(1, Math.ceil(draft.body.length / 160));
    const ready = draft.title.trim() && draft.body.trim();
    const patch = (p: Partial<BlastDraft>) => setDraft((d) => ({ ...d, ...p }));

    const lastBlast = zone.blasts[0];

    // Approval happens on the api: `approve` from this signed-in operator is the approval record.
    const deliver = async (approve: boolean) => {
        setSending(true);
        const blast =
            pendingId && approve
                ? await approveBlast(zone.id, pendingId)
                : await createBlast(zone.id, {
                      audience: draft.audience,
                      priority: draft.priority,
                      area: draft.area,
                      title: draft.title.trim(),
                      body: draft.body.trim(),
                      approve,
                  });
        setSending(false);
        if (!blast) return;
        setSent(blast);
        setStep('sent');
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
            width={step === 'compose' ? 760 : 520}
        >
            <AnimatePresence mode="wait" initial={false}>
                {step === 'compose' ? (
                    <motion.div
                        key="compose"
                        className={styles.compose}
                        initial={{ opacity: 0, x: -12 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -12, transition: QUICK }}
                        transition={SMOOTH}
                    >
                        <div className={styles.form}>
                            <div className={ui.field}>
                                <span className={ui.fieldLabel}>Send to</span>
                                <Segmented<BlastAudience>
                                    label="Audience"
                                    value={draft.audience}
                                    onChange={(audience) => patch({ audience })}
                                    options={[
                                        { value: 'civilians', label: 'Civilians' },
                                        { value: 'responders', label: 'Responders' },
                                        { value: 'both', label: 'Both' },
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
                                            transition={{ ...SMOOTH, layout: SNAP }}
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
                                            transition={{ ...SMOOTH, layout: SNAP }}
                                        >
                                            <span className={styles.from}>
                                                Ember Responder · now
                                            </span>
                                            <b>{draft.title || 'Title'}</b>
                                            <span>{draft.body || 'Your message shows here.'}</span>
                                        </motion.div>
                                    ) : null}
                                </AnimatePresence>
                            </div>
                            <p className={styles.recipients}>
                                {[
                                    civilians ? 'Civilians by SMS' : '',
                                    responders ? 'Responders by push' : '',
                                ]
                                    .filter(Boolean)
                                    .join(' · ')}
                            </p>
                        </div>

                        <div className={styles.footer}>
                            {lastBlast ? (
                                <span className={panel.muted}>
                                    Last blast “{lastBlast.title}”{' '}
                                    {ago(Date.parse(lastBlast.createdAt))}
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
                                    disabled={!ready}
                                    loading={sending}
                                    onClick={() => void deliver(false)}
                                >
                                    Send to responders
                                </Button>
                            )}
                        </div>
                    </motion.div>
                ) : step === 'approve' ? (
                    <motion.div
                        key="approve"
                        className={panel.stack}
                        initial={{ opacity: 0, x: 12 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -12, transition: QUICK }}
                        transition={SMOOTH}
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
                                <span className={panel.tag}>Civilians</span>
                                {responders ? <span className={panel.tag}>Responders</span> : null}
                            </div>
                            <strong>{draft.title}</strong>
                            <p>{draft.body}</p>
                        </div>
                        <div className={styles.record}>
                            <strong>Civilian alerts need an operator approval</strong>
                            <span className={panel.muted}>
                                {sending ? 'Signing' : 'Will be signed'} by {operator} at{' '}
                                {clock(now)}
                            </span>
                        </div>
                        <HoldButton
                            label="Hold to approve and send"
                            holdingLabel="Keep holding…"
                            onComplete={() => void deliver(true)}
                        />
                        {pendingId ? null : (
                            <Button
                                variant="ghost"
                                icon="arrowLeft"
                                onClick={() => setStep('compose')}
                            >
                                Edit message
                            </Button>
                        )}
                    </motion.div>
                ) : (
                    <motion.div
                        key="sent"
                        className={styles.sent}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={SMOOTH}
                    >
                        <motion.span
                            className={styles.sentMark}
                            initial={{ scale: 0.5, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={{ ...SNAP, delay: 0.08 }}
                        >
                            <Icon name="check" size={22} />
                        </motion.span>
                        <strong>“{sent?.title}” is queued for delivery</strong>
                        <span>
                            {sent?.audience === 'both'
                                ? 'Civilians and responders'
                                : sent?.audience === 'civilians'
                                  ? 'Civilians'
                                  : 'Responders'}
                        </span>
                        {sent?.approval ? (
                            <span className={panel.muted}>
                                Approved by {sent.approval.approverName} at{' '}
                                {clock(Date.parse(sent.approval.approvedAt))}
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
