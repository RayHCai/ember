import { CustomDataSource } from 'cesium';
import { useEffect, useState } from 'react';
import { useMap } from './viewer';

/** A named entity collection on the map for one layer, removed on unmount. */
export function useDataSource(name: string): CustomDataSource | null {
    const viewer = useMap((s) => s.viewer);
    const [source, setSource] = useState<CustomDataSource | null>(null);
    useEffect(() => {
        if (!viewer) return;
        const ds = new CustomDataSource(name);
        void viewer.dataSources.add(ds);
        setSource(ds);
        return () => {
            setSource(null);
            if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
        };
    }, [viewer, name]);
    return source;
}
