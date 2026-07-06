import { LIVE_COLLECTOR_URL } from "../liveData.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request) {
  const url = new URL(request.url);
  const seconds = url.searchParams.get("seconds") || "300";

  try {
    const response = await fetch(
      `${LIVE_COLLECTOR_URL}/ws-btc-prices.csv?seconds=${encodeURIComponent(seconds)}`,
      { cache: "no-store" }
    );

    if (!response.ok) {
      return Response.json(
        {
          ok: false,
          error: `collector returned HTTP ${response.status}`,
        },
        { status: response.status || 502 }
      );
    }

    return new Response(await response.text(), {
      status: 200,
      headers: {
        "content-type": response.headers.get("content-type") || "text/csv; charset=utf-8",
        "content-disposition":
          response.headers.get("content-disposition") ||
          'attachment; filename="websocket_btc_prices_last_5m.csv"',
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error.message || String(error),
      },
      { status: 503 }
    );
  }
}