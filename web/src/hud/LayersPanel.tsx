import { useState } from "react";
import { cx } from "../lib/format";
import { LAYERS, useAppStore } from "../state/store";
import hud from "./hud.module.css";
import styles from "./LayersPanel.module.css";

export function LayersPanel() {
  const layers = useAppStore((s) => s.layers);
  const toggleLayer = useAppStore((s) => s.toggleLayer);
  const [open, setOpen] = useState(true);

  return (
    <section className={cx(hud.panel, styles.panel)} aria-label="Layers">
      <div className={hud.header}>
        <h2 className={hud.title}>Layers</h2>
        <button type="button" className={styles.toggle} onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide" : "Show"}
        </button>
      </div>
      <ul className={styles.list} hidden={!open}>
        {LAYERS.map((layer) => (
          <li key={layer.id}>
            <label className={styles.row}>
              <input
                type="checkbox"
                className={styles.checkbox}
                checked={layers[layer.id]}
                onChange={() => toggleLayer(layer.id)}
              />
              <span className={styles.switch} aria-hidden />
              <span className={styles.name}>{layer.label}</span>
              {layer.sim && <span className={hud.simTag}>SIM</span>}
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
