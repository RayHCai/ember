import "@fontsource/chakra-petch/400.css";
import "@fontsource/chakra-petch/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { forwardErrorsToAppLog, markShell } from "./shell";
import { useObserved } from "./state/observed";
import { useAppStore } from "./state/store";
import { useTelemetry } from "./state/telemetry";
import "./styles/tokens.css";
import "./index.css";

markShell();
forwardErrorsToAppLog();
// Development only: state stores for debugging and browser tests.
if (import.meta.env.DEV) Object.assign(window, { __ember: { useAppStore, useTelemetry, useObserved } });

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
