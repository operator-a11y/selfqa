/** Proxy: SelfQA UI -> worker /api/coverage?appId=... (M7, optional/supplementary). */
const WORKER_URL = process.env.SELFQA_WORKER_URL ?? "http://127.0.0.1:4317";

export async function GET(req: Request): Promise<Response> {
  const appId = new URL(req.url).searchParams.get("appId") ?? "";
  try {
    const res = await fetch(`${WORKER_URL}/api/coverage?appId=${encodeURIComponent(appId)}`);
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
