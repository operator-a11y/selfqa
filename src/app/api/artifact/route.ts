/** Proxy: SelfQA UI -> worker /api/artifact?path=... (streams the captured bytes). */
const WORKER_URL = process.env.SELFQA_WORKER_URL ?? "http://127.0.0.1:4317";

export async function GET(req: Request): Promise<Response> {
  const p = new URL(req.url).searchParams.get("path") ?? "";
  try {
    const res = await fetch(
      `${WORKER_URL}/api/artifact?path=${encodeURIComponent(p)}`,
    );
    const buf = await res.arrayBuffer();
    return new Response(buf, {
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/octet-stream",
      },
    });
  } catch (e) {
    return Response.json(
      { error: "worker unreachable: " + (e instanceof Error ? e.message : String(e)) },
      { status: 502 },
    );
  }
}
