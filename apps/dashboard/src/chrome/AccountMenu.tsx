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
            width={240}
            anchor={
                <button
                    type="button"
                    className={styles.avatar}
                    aria-label="Account"
                    data-active={open}
                    onClick={() => setOpen(!open)}
                >
                    {initials(session.name) || <Icon name="user" size={14} />}
                </button>
            }
        >
            <div className={styles.account}>
                <strong>{session.name}</strong>
                <span>{session.email}</span>
            </div>
            <div className={styles.menu}>
                <button type="button" className={styles.menuItem} onClick={() => signOut()}>
                    <Icon name="logout" size={15} /> Sign out
                </button>
            </div>
        </Popover>
    );
}
