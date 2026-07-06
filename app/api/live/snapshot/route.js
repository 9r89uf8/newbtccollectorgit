export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LIVE_COLLECTOR_URL = (process.env.LIVE_COLLECTOR_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");

export async function GET() {
  try {
    const response = await fetch(`${LIVE_COLLECTOR_URL}/snapshot`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return Response.json(
        { ok: false, error: `collector returned HTTP ${response.status}` },
        { status: 503 }
      );
    }

    const snapshot = await response.json();
    return Response.json(snapshot, {
      headers: {
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error.message || String(error) },
      { status: 503 }
    );
  }
}
