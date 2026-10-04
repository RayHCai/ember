import { useEffect, useState } from 'react';

/** The current time, refreshed every `ms`; also re-renders live readouts. */
export function useNow(ms = 1000): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), ms);
        return () => window.clearInterval(timer);
    }, [ms]);
    return now;
}
