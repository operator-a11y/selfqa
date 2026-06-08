/** Proxy: SelfQA UI -> worker /api/promote (human approval mints a regression test). */
const WORKER_URL = process.env.SELFQA_WORKER_URL ?? "http://127.0.0.1:4317";

export async function POST(req: Request): Promise<Response> {
  const body = await req.text();
  try {
    const res = await fetch(`${WORKER_URL}/api/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return Response.json(
      { error: "worker unreachable: " + (e instanceof Error ? e.message : String(e)) },
      { status: 502 },
    );
  }
}
