/** Proxy: SelfQA UI -> worker /api/diff?appId=...&from=...&to=... (M5-L). */
const WORKER_URL = process.env.SELFQA_WORKER_URL ?? "http://127.0.0.1:4317";

export async function GET(req: Request): Promise<Response> {
  const u = new URL(req.url);
  const qs = new URLSearchParams();
  for (const k of ["appId", "from", "to"]) qs.set(k, u.searchParams.get(k) ?? "");
  try {
    const res = await fetch(`${WORKER_URL}/api/diff?${qs.toString()}`);
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
