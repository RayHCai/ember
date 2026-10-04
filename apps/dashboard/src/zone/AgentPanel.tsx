import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Icon } from '../icons/Icon';
import { respond, type ToolCall } from '../sim/agent';
import type { WatchZone } from '../sim/types';
import { useUi, type BlastDraft } from '../store/ui';
import { IconButton } from '../ui/Button';
import panel from '../ui/panel.module.css';
import styles from './AgentPanel.module.css';

interface Message {
    id: number;
    role: 'operator' | 'agent';
    text: string;
    shown: number;
    tools: ToolCall[];
    draft?: BlastDraft;
}

const PROMPTS = [
    'Summarize the zone',
    'Run a scan now',
    'Show coverage gaps',
    'Run the civilian and responder planners',
    'Text everyone within 2 mi of the fire to evacuate via Route 9',
];

// Conversations survive closing the panel and leaving the zone.
const history = new Map<string, Message[]>();
let nextId = 1;

interface Recognition {
    lang: string;
    interimResults: boolean;
    start(): void;
    stop(): void;
    onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
    onend: (() => void) | null;
}

function recognition(): (new () => Recognition) | undefined {
    const w = window as unknown as {
        SpeechRecognition?: new () => Recognition;
        webkitSpeechRecognition?: new () => Recognition;
    };
    return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function AgentPanel({ zone }: { zone: WatchZone }) {
    const setOpen = useUi((s) => s.setAgentOpen);
    const openBlast = useUi((s) => s.openBlast);
    const [messages, setMessages] = useState<Message[]>(() => history.get(zone.id) ?? []);
    const [input, setInput] = useState('');
    const [thinking, setThinking] = useState(false);
    const [listening, setListening] = useState(false);
    const [speak, setSpeak] = useState(false);
    const scroller = useRef<HTMLDivElement>(null);
    const Recognizer = recognition();

    useEffect(() => {
        history.set(zone.id, messages);
        scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
    }, [messages, zone.id]);

    // Reveal the newest reply a few words at a time.
    useEffect(() => {
        const streaming = messages.find((m) => m.role === 'agent' && m.shown < m.text.length);
        if (!streaming) return;
        const timer = window.setTimeout(() => {
            setMessages((list) =>
                list.map((m) => {
                    if (m.id !== streaming.id) return m;
                    const next = m.text.indexOf(' ', m.shown + 6);
                    return { ...m, shown: next === -1 ? m.text.length : next };
                }),
            );
        }, 28);
        return () => window.clearTimeout(timer);
    }, [messages]);

    const send = (text: string) => {
        const trimmed = text.trim();
        if (!trimmed || thinking) return;
        setInput('');
        setMessages((list) => [
            ...list,
            { id: nextId++, role: 'operator', text: trimmed, shown: trimmed.length, tools: [] },
        ]);
        setThinking(true);
        window.setTimeout(() => {
            const reply = respond(zone.id, trimmed);
            setThinking(false);
            setMessages((list) => [
                ...list,
                {
                    id: nextId++,
                    role: 'agent',
                    text: reply.text,
                    shown: 0,
                    tools: reply.tools,
                    draft: reply.draft,
                },
            ]);
            if (speak && 'speechSynthesis' in window) {
                window.speechSynthesis.cancel();
                window.speechSynthesis.speak(new SpeechSynthesisUtterance(reply.text));
            }
        }, 650);
    };

    const submit = (e: FormEvent) => {
        e.preventDefault();
        send(input);
    };

    const listen = () => {
        if (!Recognizer || listening) return;
        const rec = new Recognizer();
        rec.lang = 'en-US';
        rec.interimResults = false;
        rec.onresult = (e) => {
            const text = Array.from(e.results)
                .map((r) => r[0]?.transcript ?? '')
                .join(' ');
            setSpeak(true);
            send(text);
        };
        rec.onend = () => setListening(false);
        setListening(true);
        rec.start();
    };

    return (
        <motion.section
            layout
            className={`${panel.panel} ${styles.agent}`}
            initial={{ opacity: 0, y: 30, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 30, scale: 0.97, transition: { duration: 0.18 } }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
        >
            <header className={styles.head}>
                <span className={styles.mark}>
                    <Icon name="sparkle" size={18} />
                </span>
                <div className={styles.headText}>
                    <strong>Operator Agent</strong>
                    <span>Calls the same actions you do. Civilian texts need your approval.</span>
                </div>
                <IconButton
                    icon="live"
                    label={speak ? 'Stop reading replies aloud' : 'Read replies aloud'}
                    active={speak}
                    tip={false}
                    onClick={() => setSpeak((s) => !s)}
                />
                <IconButton
                    icon="close"
                    label="Close agent"
                    tip={false}
                    onClick={() => setOpen(false)}
                />
            </header>

            <div ref={scroller} className={styles.messages}>
                {messages.length === 0 ? (
                    <motion.div
                        className={styles.welcome}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                    >
                        <strong>What should I do for {zone.name}?</strong>
                        <span>Ask in plain words, or start with one of these.</span>
                    </motion.div>
                ) : null}
                <AnimatePresence initial={false}>
                    {messages.map((m) => (
                        <motion.div
                            key={m.id}
                            className={styles.message}
                            data-role={m.role}
                            initial={{ opacity: 0, y: 10, scale: 0.98 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                        >
                            {m.tools.length ? (
                                <div className={styles.tools}>
                                    {m.tools.map((t, i) => (
                                        <motion.span
                                            key={`${t.name}-${i}`}
                                            className={styles.tool}
                                            initial={{ opacity: 0, x: -6 }}
                                            animate={{ opacity: 1, x: 0 }}
                                            transition={{ delay: i * 0.12 }}
                                        >
                                            <Icon name="check" size={10} />
                                            <code>{t.name}</code>
                                            <span>{t.args}</span>
                                        </motion.span>
                                    ))}
                                </div>
                            ) : null}
                            <p>
                                {m.text.slice(0, m.shown)}
                                {m.shown < m.text.length ? <span className={styles.caret} /> : null}
                            </p>
                            {m.draft && m.shown >= m.text.length ? (
                                <motion.div
                                    className={styles.draft}
                                    initial={{ opacity: 0, y: 6 }}
                                    animate={{ opacity: 1, y: 0 }}
                                >
                                    <span className={styles.draftHead}>
                                        <Icon name="megaphone" size={14} /> Draft ·{' '}
                                        {m.draft.audience} · {m.draft.priority}
                                    </span>
                                    <strong>{m.draft.title}</strong>
                                    <span>{m.draft.body}</span>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            m.draft &&
                                            openBlast(m.draft, m.draft.audience !== 'responders')
                                        }
                                    >
                                        {m.draft.audience === 'responders'
                                            ? 'Review and send'
                                            : 'Review and approve'}
                                        <Icon name="arrowRight" size={13} />
                                    </button>
                                </motion.div>
                            ) : null}
                        </motion.div>
                    ))}
                </AnimatePresence>
                {thinking ? (
                    <motion.div
                        className={styles.message}
                        data-role="agent"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                    >
                        <span className={styles.dots}>
                            <i />
                            <i />
                            <i />
                        </span>
                    </motion.div>
                ) : null}
            </div>

            <div className={styles.prompts}>
                {PROMPTS.map((p) => (
                    <button key={p} type="button" onClick={() => send(p)} disabled={thinking}>
                        {p}
                    </button>
                ))}
            </div>

            <form className={styles.composer} onSubmit={submit}>
                <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={listening ? 'Listening…' : 'Ask or tell the agent'}
                    aria-label="Message the Operator Agent"
                />
                <button
                    type="button"
                    className={styles.micButton}
                    data-listening={listening}
                    disabled={!Recognizer}
                    title={
                        Recognizer ? 'Speak a command' : 'Speech recognition is not available here'
                    }
                    onClick={listen}
                >
                    <Icon name="mic" size={16} />
                </button>
                <button
                    type="submit"
                    className={styles.sendButton}
                    disabled={!input.trim() || thinking}
                    aria-label="Send"
                >
                    <Icon name="send" size={16} />
                </button>
            </form>
        </motion.section>
    );
}
