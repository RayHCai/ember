import { AnimatePresence, motion, useAnimationControls } from 'motion/react';
import { useId, useState, type FormEvent } from 'react';
import { Icon } from '../icons/Icon';
import type { GlyphName } from '../icons/glyphs';
import { Logo } from '../icons/Logo';
import { DEMO_ACCOUNT, useSession } from '../store/session';
import { Button } from '../ui/Button';
import { Segmented } from '../ui/Segmented';
import ui from '../ui/ui.module.css';
import { Embers } from './Embers';
import styles from './LoginPage.module.css';

type Mode = 'signin' | 'signup';

const FEATURES: { icon: GlyphName; title: string; body: string }[] = [
    {
        icon: 'tree',
        title: 'Watch zones',
        body: 'Draw a forest, deploy edge servers, pair drones.',
    },
    {
        icon: 'radar',
        title: 'Live detection',
        body: 'Watch the fleet map risk and fire in real time.',
    },
    {
        icon: 'route',
        title: 'Plans and alerts',
        body: 'Evacuation paths, drop sites and approved blasts.',
    },
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginPage() {
    const notice = useSession((s) => s.notice);
    const signIn = useSession((s) => s.signIn);
    const signUp = useSession((s) => s.signUp);
    const [mode, setMode] = useState<Mode>('signin');
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [reveal, setReveal] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const shake = useAnimationControls();
    const passwordId = useId();

    const fail = (message: string) => {
        setError(message);
        void shake.start({ x: [0, -10, 9, -6, 4, 0], transition: { duration: 0.42 } });
    };

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setError(null);
        if (mode === 'signup' && !name.trim())
            return fail('Add your name so responders know who is sending.');
        if (!EMAIL.test(email.trim())) return fail('Enter a valid email address.');
        if (password.length < (mode === 'signup' ? 8 : 1)) {
            return fail(
                mode === 'signup'
                    ? 'Use at least 8 characters for your password.'
                    : 'Enter your password.',
            );
        }
        setBusy(true);
        try {
            if (mode === 'signin') await signIn(email, password);
            else await signUp(name, email, password);
        } catch (err) {
            fail(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={styles.page}>
            <section className={styles.hero}>
                <Embers />
                <div className={styles.heroGlow} aria-hidden />
                <motion.div
                    className={styles.heroInner}
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                >
                    <Logo size={92} assemble alive />
                    <h1 className={styles.heroTitle}>
                        See fire
                        <br />
                        <span className={styles.heroAccent}>before it spreads.</span>
                    </h1>
                    <p className={styles.heroLead}>
                        Ember watches every acre with drones and edge servers, then turns what they
                        see into plans for responders and civilians.
                    </p>
                    <ul className={styles.features}>
                        {FEATURES.map((f, i) => (
                            <motion.li
                                key={f.title}
                                initial={{ opacity: 0, x: -14 }}
                                animate={{ opacity: 1, x: 0 }}
                                transition={{
                                    delay: 0.9 + i * 0.12,
                                    type: 'spring',
                                    stiffness: 260,
                                    damping: 24,
                                }}
                            >
                                <span className={styles.featureIcon}>
                                    <Icon name={f.icon} size={18} />
                                </span>
                                <span>
                                    <strong>{f.title}</strong>
                                    <span>{f.body}</span>
                                </span>
                            </motion.li>
                        ))}
                    </ul>
                </motion.div>
            </section>

            <section className={styles.formSide}>
                <motion.form
                    className={styles.card}
                    onSubmit={submit}
                    noValidate
                    initial={{ opacity: 0, y: 24, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ delay: 0.15, type: 'spring', stiffness: 220, damping: 26 }}
                >
                    <motion.div animate={shake}>
                        <div className={styles.cardHead}>
                            <Logo size={34} />
                            <div>
                                <h2>
                                    {mode === 'signin' ? 'Welcome back' : 'Create your account'}
                                </h2>
                                <p>
                                    {mode === 'signin'
                                        ? 'Sign in to the operator console.'
                                        : 'Operators manage watch zones and alerts.'}
                                </p>
                            </div>
                        </div>

                        <Segmented<Mode>
                            label="Account"
                            value={mode}
                            onChange={(m) => {
                                setMode(m);
                                setError(null);
                            }}
                            options={[
                                { value: 'signin', label: 'Sign in' },
                                { value: 'signup', label: 'Create account' },
                            ]}
                            className={styles.tabs}
                        />

                        <AnimatePresence initial={false}>
                            {notice && mode === 'signin' ? (
                                <motion.p
                                    className={styles.notice}
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: 'auto' }}
                                    exit={{ opacity: 0, height: 0 }}
                                >
                                    <Icon name="clock" size={15} /> {notice}
                                </motion.p>
                            ) : null}
                        </AnimatePresence>

                        <div className={styles.fields}>
                            <AnimatePresence initial={false}>
                                {mode === 'signup' ? (
                                    <motion.label
                                        className={ui.field}
                                        initial={{ opacity: 0, height: 0 }}
                                        animate={{ opacity: 1, height: 'auto' }}
                                        exit={{ opacity: 0, height: 0 }}
                                        transition={{ type: 'spring', stiffness: 380, damping: 34 }}
                                        style={{ overflow: 'hidden' }}
                                    >
                                        <span className={ui.fieldLabel}>Name</span>
                                        <input
                                            className={ui.input}
                                            value={name}
                                            onChange={(e) => setName(e.target.value)}
                                            placeholder="Alex Rivera"
                                            autoComplete="name"
                                        />
                                    </motion.label>
                                ) : null}
                            </AnimatePresence>
                            <label className={ui.field}>
                                <span className={ui.fieldLabel}>Email</span>
                                <input
                                    className={ui.input}
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    placeholder="you@agency.gov"
                                    autoComplete="email"
                                    autoFocus
                                />
                            </label>
                            <div className={ui.field}>
                                <label htmlFor={passwordId} className={ui.fieldLabel}>
                                    Password
                                </label>
                                <span className={styles.passwordWrap}>
                                    <input
                                        id={passwordId}
                                        className={ui.input}
                                        type={reveal ? 'text' : 'password'}
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        placeholder={
                                            mode === 'signup'
                                                ? 'At least 8 characters'
                                                : 'Your password'
                                        }
                                        autoComplete={
                                            mode === 'signup' ? 'new-password' : 'current-password'
                                        }
                                    />
                                    <button
                                        type="button"
                                        className={styles.reveal}
                                        aria-label={reveal ? 'Hide password' : 'Show password'}
                                        onClick={() => setReveal((r) => !r)}
                                    >
                                        <Icon name={reveal ? 'eye' : 'lock'} size={16} />
                                    </button>
                                </span>
                            </div>
                        </div>

                        <AnimatePresence>
                            {error ? (
                                <motion.p
                                    role="alert"
                                    className={styles.error}
                                    initial={{ opacity: 0, y: -4 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0 }}
                                >
                                    <Icon name="alert" size={14} /> {error}
                                </motion.p>
                            ) : null}
                        </AnimatePresence>

                        <Button
                            type="submit"
                            variant="primary"
                            size="lg"
                            block
                            loading={busy}
                            iconAfter="arrowRight"
                        >
                            {mode === 'signin' ? 'Sign in' : 'Create account'}
                        </Button>

                        <button
                            type="button"
                            className={styles.demo}
                            onClick={() => {
                                setMode('signin');
                                setEmail(DEMO_ACCOUNT.email);
                                setPassword(DEMO_ACCOUNT.password);
                                setError(null);
                            }}
                        >
                            <Icon name="sparkle" size={14} /> Fill in the demo account
                        </button>
                        <p className={styles.footnote}>
                            You stay signed in on this device for 7 days.
                        </p>
                    </motion.div>
                </motion.form>
            </section>
        </div>
    );
}
