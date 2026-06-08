/**
 * SelfQA worker — the long-running process (SPEC §14.1).
 *
 * It will own: the job queue, codegen calls (build-agent / edit-agent /
 * spec-extractor through the LLM provider), and the *lifecycle* of generated-app
 * subprocesses (SPEC §14.2) — none of which fit Next's request/response model.
 * The Next UI talks to it and streams live walk progress over SSE/WebSocket.
 *
 * M1: a thin, honest skeleton. Jobs land here as the loop is built out.
 */

const PORT = Number(process.env.SELFQA_WORKER_PORT ?? 4317);

function main(): void {
  console.log(`[selfqa-worker] starting (pid ${process.pid}); reserved port ${PORT}`);
  // TODO(M1): job queue · codegen via LLMProvider · generated-app subprocess
  //           lifecycle (start/kill/reap, egress-blocked) · SSE progress bridge.

  const shutdown = (signal: string) => {
    console.log(`[selfqa-worker] received ${signal}, shutting down`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep the event loop alive until a job system is wired in.
  setInterval(() => {
    /* heartbeat placeholder */
  }, 60_000);
}

main();
