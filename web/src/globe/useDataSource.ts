import { CustomDataSource, type Viewer } from "cesium";
import { useEffect, useState } from "react";

/** A named entity collection on the globe for one layer, removed on unmount. */
export function useDataSource(viewer: Viewer | null, name: string): CustomDataSource | null {
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
