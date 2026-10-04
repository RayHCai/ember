import { Icon } from '../icons/Icon';
import styles from './ui.module.css';

/** The faceted radar glyph, turning. */
export function Spinner({ size = 16 }: { size?: number }) {
    return <Icon name="radar" size={size} className={styles.spinner} />;
}
