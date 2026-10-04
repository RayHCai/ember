import Svg, { Circle, Path } from 'react-native-svg';

type IconProps = { size?: number; color: string };

const stroke = {
    fill: 'none',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
} as const;

export function MoreIcon({ size = 22, color }: IconProps) {
    return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
            <Circle cx={5.5} cy={12} r={1.8} fill={color} />
            <Circle cx={12} cy={12} r={1.8} fill={color} />
            <Circle cx={18.5} cy={12} r={1.8} fill={color} />
        </Svg>
    );
}

export function RecenterIcon({ size = 22, color }: IconProps) {
    return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
            <Path
                d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"
                stroke={color}
                {...stroke}
            />
            <Circle cx={12} cy={12} r={2.5} fill={color} />
        </Svg>
    );
}

export function PinIcon({ size = 14, color }: IconProps) {
    return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
            <Path
                d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"
                stroke={color}
                {...stroke}
            />
            <Circle cx={12} cy={10} r={2.2} fill={color} />
        </Svg>
    );
}
