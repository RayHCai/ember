import { AnimatePresence, motion, useAnimationControls } from 'motion/react';
import { useState, type FormEvent } from 'react';
import { message as errorMessage } from '../api/client';
import { Logo } from '../icons/Logo';
import { useSession } from '../store/session';
import { Button } from '../ui/Button';
import { QUICK, SMOOTH } from '../ui/motion';
import styles from './LoginPage.module.css';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

type Field = 'name' | 'email' | 'password' | 'both';
type Mode = 'sign-in' | 'sign-up';

export function LoginPage() {
    const notice = useSession((s) => s.notice);
    const signIn = useSession((s) => s.signIn);
    const signUp = useSession((s) => s.signUp);
    const [mode, setMode] = useState<Mode>('sign-in');
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState<{ message: string; field: Field } | null>(null);
    const [busy, setBusy] = useState(false);
    const shake = useAnimationControls();
    const signingUp = mode === 'sign-up';

    const fail = (message: string, field: Field) => {
        setError({ message, field });
        void shake.start({ x: [0, -7, 6, -4, 2, 0], transition: { duration: 0.4 } });
    };

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setError(null);
        if (signingUp && !name.trim()) return fail('Enter your name.', 'name');
        if (!EMAIL.test(email.trim())) return fail('Enter a valid email address.', 'email');
        if (!password) return fail('Enter your password.', 'password');
        if (signingUp && password.length < MIN_PASSWORD)
            return fail(`Use at least ${MIN_PASSWORD} characters.`, 'password');
        setBusy(true);
        try {
            if (signingUp) await signUp(name, email, password);
            else await signIn(email, password);
        } catch (err) {
            fail(errorMessage(err), signingUp ? 'email' : 'both');
        } finally {
            setBusy(false);
        }
    };

    const switchMode = () => {
        setMode(signingUp ? 'sign-in' : 'sign-up');
        setError(null);
    };

    const message = error?.message ?? notice;
    const invalid = (field: Field) => error?.field === field || error?.field === 'both';

    return (
        <div className={styles.page}>
            <form className={styles.form} onSubmit={submit} noValidate>
                <h1 className={styles.brand}>
                    <Logo size={40} />
                    ember
                </h1>
                <motion.div className={styles.fields} animate={shake}>
                    <AnimatePresence initial={false}>
                        {signingUp ? (
                            <motion.input
                                key="name"
                                className={styles.input}
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="Name"
                                aria-label="Name"
                                aria-invalid={invalid('name')}
                                autoComplete="name"
                                autoFocus
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 36 }}
                                exit={{ opacity: 0, height: 0, transition: QUICK }}
                                transition={SMOOTH}
                            />
                        ) : null}
                    </AnimatePresence>
                    <input
                        className={styles.input}
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="Email"
                        aria-label="Email"
                        aria-invalid={invalid('email')}
                        autoComplete="email"
                        autoFocus
                    />
                    <input
                        className={styles.input}
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Password"
                        aria-label="Password"
                        aria-invalid={invalid('password')}
                        autoComplete={signingUp ? 'new-password' : 'current-password'}
                    />
                    <Button type="submit" variant="primary" size="lg" block loading={busy}>
                        {signingUp ? 'Create account' : 'Sign in'}
                    </Button>
                </motion.div>
                <button type="button" className={styles.switch} onClick={switchMode}>
                    {signingUp ? 'I have an account' : 'Create an account'}
                </button>
                <div className={styles.messageSlot}>
                    <AnimatePresence mode="wait" initial={false}>
                        {message ? (
                            <motion.p
                                key={message}
                                role={error ? 'alert' : 'status'}
                                className={styles.message}
                                data-error={error !== null}
                                initial={{ opacity: 0, y: -4 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0 }}
                                transition={QUICK}
                            >
                                {message}
                            </motion.p>
                        ) : null}
                    </AnimatePresence>
                </div>
            </form>
        </div>
    );
}
