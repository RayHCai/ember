import type { CSSProperties } from 'react';
import { GLYPHS, type GlyphName } from './glyphs';

interface IconProps {
    name: GlyphName;
    size?: number;
    className?: string;
    style?: CSSProperties;
    title?: string;
}

/** A faceted glyph in the current text color. Seams take `--facet`, the surface behind it. */
export function Icon({ name, size = 18, className, style, title }: IconProps) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            className={className}
            style={{ flexShrink: 0, ...style }}
            role={title ? 'img' : undefined}
            aria-hidden={title ? undefined : true}
            aria-label={title}
        >
            <g stroke="var(--facet)" strokeWidth={0.75} strokeLinejoin="round">
                {GLYPHS[name].map((facet, i) => (
                    <polygon
                        key={i}
                        points={facet.points}
                        fill={facet.cut ? 'var(--facet)' : 'currentColor'}
                    />
                ))}
            </g>
        </svg>
    );
}
