/**
 * Generated-app runner (SPEC §14.2 / §14.3).
 *
 * Each generated app runs as a lifecycle-managed `next dev` subprocess on an
 * allocated port; the UI/iframe and (later) Playwright target localhost:port.
 * Subprocesses are started detached (own process group) so the whole tree can
 * be reaped, and are tracked in a registry that's killed on worker exit.
 *
 * SERVER-ONLY (node:child_process, node:net, node:fs).
 *
 * Egress (SPEC §14.3): true per-process egress blocking is straightforward on
 * Linux (network namespaces) but has no cheap equivalent on macOS without a
 * container. On macOS the primary guarantee is "fixtures mock everything", and
 * hard egress enforcement is the Docker/microVM earned hardening (SPEC §14.4).
 * We mark the child and fail proxies fast, but this is NOT a security boundary.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import net from "node:net";

const exec = promisify(execFile);

export interface RunningApp {
  id: string;
  dir: string;
  port: number;
  url: string;
  proc: ChildProcess;
  stop: () => Promise<void>;
}

const registry = new Set<RunningApp>();

/** Ask the OS for a free TCP port on loopback. */
export function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not allocate a port")));
      }
    });
  });
}

/** Install deps once per generated app (skip if node_modules already present). */
export async function ensureDeps(dir: string): Promise<void> {
  try {
    await fs.access(path.join(dir, "node_modules"));
    return;
  } catch {
    /* not installed yet */
  }
  await exec("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: dir,
    maxBuffer: 1 << 26,
  });
}

/** SPEC §14.3 — best-effort egress signal (NOT a security boundary on macOS). */
function egressEnv(): Record<string, string> {
  return {
    SELFQA_EGRESS: "blocked",
    // Route accidental outbound through a dead proxy so it fails fast rather
    // than silently succeeding. Real enforcement = Docker/microVM (SPEC §14.4).
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "127.0.0.1,localhost",
  };
}

export async function startApp(
  dir: string,
  opts: { id: string; readyTimeoutMs?: number },
): Promise<RunningApp> {
  await ensureDeps(dir);
  const port = await allocatePort();
  const url = `http://127.0.0.1:${port}`;

  let stderr = "";
  const proc = spawn("npm", ["run", "dev", "--", "-p", String(port)], {
    cwd: dir,
    detached: true,
    env: { ...process.env, ...egressEnv() },
    stdio: ["ignore", "ignore", "pipe"],
  });
  proc.stderr?.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });

  const app: RunningApp = {
    id: opts.id,
    dir,
    port,
    url,
    proc,
    stop: () => stopApp(app),
  };
  registry.add(app);

  try {
    await waitForReady(url, opts.readyTimeoutMs ?? 90_000, proc, () => stderr);
  } catch (e) {
    await stopApp(app);
    throw e;
  }
  return app;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForReady(
  url: string,
  timeoutMs: number,
  proc: ChildProcess,
  getStderr: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(
        `dev server exited early (code ${proc.exitCode}). stderr:\n${getStderr()}`,
      );
    }
    try {
      const res = await fetch(url, { method: "GET" });
      // Any non-server-error response means the server is up and routing.
      if (res.status < 500) return;
    } catch (e) {
      lastErr = e;
    }
    await delay(500);
  }
  throw new Error(
    `dev server not ready within ${timeoutMs}ms (last error: ${String(lastErr)}). stderr:\n${getStderr()}`,
  );
}

export async function stopApp(app: RunningApp): Promise<void> {
  registry.delete(app);
  const pid = app.proc.pid;
  if (pid && app.proc.exitCode === null) {
    try {
      // Negative pid = kill the whole process group (next + its workers).
      process.kill(-pid, "SIGTERM");
    } catch {
      /* group already gone */
    }
  }
}

export async function stopAll(): Promise<void> {
  await Promise.all([...registry].map((a) => stopApp(a)));
}

// Reap orphans if the owning process dies (SPEC §14.2). Handlers must be sync.
function reapAll(): void {
  for (const app of registry) {
    const pid = app.proc.pid;
    if (pid) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        /* ignore */
      }
    }
  }
}
process.once("exit", reapAll);
process.once("SIGINT", () => {
  reapAll();
  process.exit(0);
});
process.once("SIGTERM", () => {
  reapAll();
  process.exit(0);
});
