export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LIVE_COLLECTOR_URL = (process.env.LIVE_COLLECTOR_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");

export async function GET(request) {
  try {
    const response = await fetch(`${LIVE_COLLECTOR_URL}/events`, {
      cache: "no-store",
      headers: {
        accept: "text/event-stream",
      },
      signal: request.signal,
    });

    if (!response.ok || !response.body) {
      return Response.json(
        { ok: false, error: `collector returned HTTP ${response.status}` },
        { status: 503 }
      );
    }

    return new Response(response.body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error.message || String(error) },
      { status: 503 }
    );
  }
}
