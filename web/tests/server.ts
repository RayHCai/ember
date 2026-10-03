import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { LIVE_SERVER_PORT } from "../playwright.config";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const PYTHON = `${REPO}.venv/bin/python`;

export const serverUrl = `http://127.0.0.1:${LIVE_SERVER_PORT}`;

/** A real Ember server for live-mode tests, which the test can stop and restart. */
export class TestServer {
  private proc: ChildProcess | null = null;

  constructor(private readonly env: Record<string, string> = {}) {}

  async start(): Promise<void> {
    this.proc = spawn(
      PYTHON,
      ["-m", "uvicorn", "app.main:app", "--app-dir", `${REPO}server`, "--port", String(LIVE_SERVER_PORT)],
      { cwd: REPO, stdio: "ignore", env: { ...process.env, ...this.env } },
    );
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${serverUrl}/health`);
        if (res.ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("Test server did not become healthy");
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.exitCode !== null) return;
    proc.kill("SIGTERM");
    await once(proc, "exit");
  }
}
