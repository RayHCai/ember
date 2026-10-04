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
        // `add` lands a microtask later; removing before then would leave this one on the map.
        const added = viewer.dataSources.add(ds);
        setSource(ds);
        return () => {
            setSource(null);
            void added.then(() => {
                if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
            });
        };
    }, [viewer, name]);
    return source;
}
