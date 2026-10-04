import { motion } from 'motion/react';
import { useState } from 'react';
import { Icon } from '../icons/Icon';
import { useNotices } from '../store/notifications';
import { navigate } from '../store/router';
import { IconButton } from '../ui/Button';
import { ago } from '../ui/format';
import { SEVERITY_ICON } from '../ui/Toasts';
import styles from './chrome.module.css';
import { Popover } from './Popover';

export function NotificationsMenu() {
    const notices = useNotices((s) => s.notices);
    const markAllRead = useNotices((s) => s.markAllRead);
    const [open, setOpen] = useState(false);
    const unread = notices.filter((n) => !n.read).length;

    return (
        <Popover
            open={open}
            onClose={() => {
                setOpen(false);
                markAllRead();
            }}
            width={380}
            anchor={
                <IconButton
                    icon="bell"
                    label="Notifications"
                    count={unread}
                    active={open}
                    onClick={() => {
                        if (open) markAllRead();
                        setOpen(!open);
                    }}
                />
            }
        >
            <div className={styles.menuHead}>
                <strong>Notifications</strong>
                {notices.length ? (
                    <button type="button" className={styles.link} onClick={markAllRead}>
                        Mark all read
                    </button>
                ) : null}
            </div>
            <div className={styles.noticeList}>
                {notices.length === 0 ? (
                    <div className={styles.empty}>
                        <Icon name="bell" size={22} />
                        <span>
                            Scan results, detections and sent blasts show up here as they happen.
                        </span>
                    </div>
                ) : (
                    notices.map((n, i) => (
                        <motion.button
                            key={n.id}
                            type="button"
                            className={styles.notice}
                            data-severity={n.severity}
                            data-read={n.read}
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: Math.min(i, 8) * 0.03 }}
                            onClick={() => {
                                setOpen(false);
                                markAllRead();
                                if (n.zoneId) navigate({ name: 'zone', zoneId: n.zoneId });
                            }}
                        >
                            <span className={styles.noticeIcon}>
                                <Icon name={SEVERITY_ICON[n.severity]} size={15} />
                            </span>
                            <span className={styles.noticeText}>
                                <strong>{n.title}</strong>
                                {n.body ? <span>{n.body}</span> : null}
                                <em>
                                    {n.zoneName ? `${n.zoneName} · ` : ''}
                                    {ago(n.at)}
                                    {n.pushed ? ` · pushed to ${n.pushed} phones` : ''}
                                </em>
                            </span>
                        </motion.button>
                    ))
                )}
            </div>
        </Popover>
    );
}
