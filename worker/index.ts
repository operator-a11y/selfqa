/**
 * SelfQA worker — the long-running process (SPEC §14.1).
 *
 * Owns codegen (via the swappable LLMProvider) and the lifecycle of
 * generated-app subprocesses. The Next UI proxies to this HTTP API; none of
 * this fits Next's request/response model. SSE progress + the full re-walk
 * engine arrive in later milestones; M1 keeps it to build (+ comment in D).
 */
import http from "node:http";
import { getProvider } from "../src/lib/core/provider/factory";
import { buildApp, type GeneratedApp } from "../src/lib/core/codegen/build-agent";
import { instrument } from "../src/lib/core/instrument/inject";
import {
  writeGeneratedApp,
  currentSha,
  type AppRepo,
} from "../src/lib/core/workspace/repo";
import { startApp, stopAll, type RunningApp } from "../src/lib/core/runner/app-runner";

const PORT = Number(process.env.SELFQA_WORKER_PORT ?? 4317);
const provider = getProvider();

interface BuiltApp {
  appId: string;
  repo: AppRepo;
  app: GeneratedApp;
  running: RunningApp;
}
const apps = new Map<string, BuiltApp>();

let counter = 0;
function newAppId(): string {
  counter += 1;
  return "app-" + Date.now().toString(36) + "-" + counter;
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 2_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  const text = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/health") {
      return sendJson(res, 200, { ok: true, provider: provider.name });
    }

    if (req.method === "POST" && req.url === "/api/build") {
      const body = await readJson(req);
      const prompt = String(body.prompt ?? "").trim();
      if (!prompt) return sendJson(res, 400, { error: "prompt is required" });

      const appId = newAppId();
      console.log(`[worker] build ${appId}: ${prompt}`);
      const generated = instrument(await buildApp(provider, prompt));
      const repo = await writeGeneratedApp(appId, generated.files);
      const running = await startApp(repo.dir, { id: appId });
      const sha = await currentSha(repo.dir);
      apps.set(appId, { appId, repo, app: generated, running });
      console.log(`[worker] build ${appId} ready at ${running.url} (sha ${sha})`);
      return sendJson(res, 200, { appId, url: running.url, sha });
    }

    if (req.method === "POST" && req.url === "/api/comment") {
      // Checkpoint D: spec-extractor → edit-agent → reload.
      return sendJson(res, 501, {
        error: "the comment→edit loop arrives in Checkpoint D",
      });
    }

    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    console.error("[worker] error:", e);
    sendJson(res, 500, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `[selfqa-worker] http://127.0.0.1:${PORT} (provider: ${provider.name}, pid ${process.pid})`,
  );
});

function shutdown(signal: string): void {
  console.log(`[selfqa-worker] ${signal} — stopping ${apps.size} app(s)`);
  void stopAll().finally(() => process.exit(0));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
