/**
 * Generated-app runner (SPEC §14.2 / §14.3).
 *
 * Each generated app runs as a lifecycle-managed PRODUCTION server: `next build`
 * then `next start` on an allocated port. Production (not `next dev`) because:
 *  - `next dev` (Next 16 + Turbopack, this harness) does not reliably hydrate,
 *    which breaks all interactivity (the walk + the iframe both need it);
 *  - production has no HMR socket / on-demand compile races, so the walk is more
 *    deterministic — squarely the SPEC's goal.
 * Edits are reflected by rebuildApp() (rebuild + restart), not Fast-Refresh.
 *
 * Subprocesses are started detached (own process group) so the whole tree can be
 * reaped, and are tracked in a registry killed on worker exit.
 *
 * Egress (SPEC §14.3): the RUN step is egress-blocked (dead proxy); the BUILD
 * step runs without the proxy (it is our trusted codegen step). Hard per-process
 * enforcement is the Docker/microVM earned hardening (SPEC §14.4); not a boundary.
 *
 * SERVER-ONLY (node:child_process, node:net, node:fs).
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

/** Production build (trusted codegen step; no egress proxy). */
export async function nextBuild(dir: string): Promise<void> {
  await exec("npm", ["run", "build"], {
    cwd: dir,
    maxBuffer: 1 << 26,
    env: { ...process.env },
  });
}

/** SPEC §14.3 — best-effort egress signal at RUN time (NOT a security boundary on macOS). */
function egressEnv(): Record<string, string> {
  if (process.env.SELFQA_DISABLE_EGRESS_PROXY) {
    return { SELFQA_EGRESS: "off" };
  }
  return {
    SELFQA_EGRESS: "blocked",
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "127.0.0.1,localhost",
  };
}

async function launchServer(
  dir: string,
  id: string,
  readyTimeoutMs: number,
): Promise<RunningApp> {
  const port = await allocatePort();
  const url = `http://127.0.0.1:${port}`;

  let stderr = "";
  const proc = spawn("npm", ["run", "start", "--", "-p", String(port)], {
    cwd: dir,
    detached: true,
    env: { ...process.env, ...egressEnv() },
    stdio: ["ignore", "ignore", "pipe"],
  });
  proc.stderr?.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });

  const app: RunningApp = {
    id,
    dir,
    port,
    url,
    proc,
    stop: () => stopApp(app),
  };
  registry.add(app);

  try {
    await waitForReady(url, readyTimeoutMs, proc, () => stderr);
  } catch (e) {
    await stopApp(app);
    throw e;
  }
  return app;
}

export async function startApp(
  dir: string,
  opts: { id: string; readyTimeoutMs?: number },
): Promise<RunningApp> {
  await ensureDeps(dir);
  await nextBuild(dir);
  return launchServer(dir, opts.id, opts.readyTimeoutMs ?? 90_000);
}

/** Reflect an edit: stop, rebuild, relaunch (production has no Fast-Refresh). */
export async function rebuildApp(
  app: RunningApp,
  opts: { readyTimeoutMs?: number } = {},
): Promise<RunningApp> {
  await stopApp(app);
  await nextBuild(app.dir);
  return launchServer(app.dir, app.id, opts.readyTimeoutMs ?? 90_000);
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
        `app server exited early (code ${proc.exitCode}). stderr:\n${getStderr()}`,
      );
    }
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.status < 500) return;
    } catch (e) {
      lastErr = e;
    }
    await delay(500);
  }
  throw new Error(
    `app server not ready within ${timeoutMs}ms (last error: ${String(lastErr)}). stderr:\n${getStderr()}`,
  );
}

export async function stopApp(app: RunningApp): Promise<void> {
  registry.delete(app);
  const pid = app.proc.pid;
  if (pid && app.proc.exitCode === null) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      /* group already gone */
    }
  }
}

export async function stopAll(): Promise<void> {
  await Promise.all([...registry].map((a) => stopApp(a)));
}

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
