import { Globe } from "./globe/Globe";
import { useAppStore } from "./state/store";

export function App() {
  const globeReady = useAppStore((s) => s.globeReady);

  return (
    <main data-globe-ready={globeReady}>
      <Globe />
    </main>
  );
}
