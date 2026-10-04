import { useState } from 'react';
import { Icon } from '../icons/Icon';
import { useSession } from '../store/session';
import styles from './chrome.module.css';
import { Popover } from './Popover';

function initials(name: string): string {
    return name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0]!.toUpperCase())
        .join('');
}

export function AccountMenu() {
    const session = useSession((s) => s.session);
    const signOut = useSession((s) => s.signOut);
    const [open, setOpen] = useState(false);
    if (!session) return null;

    return (
        <Popover
            open={open}
            onClose={() => setOpen(false)}
            width={260}
            anchor={
                <button
                    type="button"
                    className={styles.avatar}
                    aria-label="Account"
                    onClick={() => setOpen(!open)}
                >
                    {initials(session.name) || <Icon name="user" size={16} />}
                </button>
            }
        >
            <div className={styles.account}>
                <span className={styles.avatarLarge}>{initials(session.name)}</span>
                <strong>{session.name}</strong>
                <span>{session.email}</span>
                <em>
                    Signed in until{' '}
                    {new Date(session.expiresAt).toLocaleDateString([], {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                    })}
                </em>
            </div>
            <button type="button" className={styles.menuItem} onClick={() => signOut()}>
                <Icon name="logout" size={16} /> Sign out
            </button>
        </Popover>
    );
}
