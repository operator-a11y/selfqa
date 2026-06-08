/** Proxy: SelfQA UI -> worker /api/regressions?appId=...[&status=...] (M5-L). */
const WORKER_URL = process.env.SELFQA_WORKER_URL ?? "http://127.0.0.1:4317";

export async function GET(req: Request): Promise<Response> {
  const u = new URL(req.url);
  const qs = new URLSearchParams();
  qs.set("appId", u.searchParams.get("appId") ?? "");
  const status = u.searchParams.get("status");
  if (status) qs.set("status", status);
  try {
    const res = await fetch(`${WORKER_URL}/api/regressions?${qs.toString()}`);
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
