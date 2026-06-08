/**
 * Proxy: SelfQA UI → worker /api/comment (Checkpoint D wires the edit loop).
 */
const WORKER_URL = process.env.SELFQA_WORKER_URL ?? "http://127.0.0.1:4317";

export async function POST(req: Request): Promise<Response> {
  const body = await req.text();
  try {
    const res = await fetch(`${WORKER_URL}/api/comment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return Response.json(
      {
        error:
          "Could not reach the SelfQA worker. Start it with `npm run worker`. " +
          (e instanceof Error ? e.message : String(e)),
      },
      { status: 502 },
    );
  }
}
