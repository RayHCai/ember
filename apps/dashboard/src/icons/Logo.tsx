import markUrl from '../../../../assets/brand/icon.svg';

/** The Ember mark, straight from assets/brand. Always shown beside the name, so it has no alt text. */
export function Logo({ size = 32, className }: { size?: number; className?: string }) {
    return (
        <img
            src={markUrl}
            width={size}
            height={size}
            alt=""
            className={className}
            style={{ flexShrink: 0 }}
        />
    );
}

/** Mark plus wordmark, set like the other Ember apps: lowercase, wide, in Gloock. */
export function Wordmark({ size = 24 }: { size?: number }) {
    return (
        <span
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.36em',
                fontFamily: 'var(--font-serif)',
                fontSize: size,
                lineHeight: 1,
                letterSpacing: '0.14em',
            }}
        >
            <Logo size={size} />
            ember
        </span>
    );
}
