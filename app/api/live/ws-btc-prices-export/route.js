import { LIVE_COLLECTOR_URL } from "../liveData.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request) {
  const url = new URL(request.url);
  const seconds = url.searchParams.get("seconds") || "300";
  const collectorUrl = `${LIVE_COLLECTOR_URL}/ws-btc-prices.csv?seconds=${encodeURIComponent(seconds)}`;

  try {
    const response = await fetch(collectorUrl, { cache: "no-store" });

    if (!response.ok) {
      return Response.json(
        {
          ok: false,
          error:
            response.status === 404
              ? "Collector live API is reachable, but this collector process does not have the websocket BTC CSV endpoint yet. Restart or deploy the updated collector."
              : `Collector live API returned HTTP ${response.status}.`,
          collectorUrl: LIVE_COLLECTOR_URL,
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
          'attachment; filename="websocket_btc_prices_chainlink_paired_last_5m.csv"',
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error:
          `Collector live API is not reachable at ${LIVE_COLLECTOR_URL}. ` +
          "Start or restart the collector, then leave it running for about 5 minutes before downloading.",
        cause: error.message || String(error),
        collectorUrl: LIVE_COLLECTOR_URL,
      },
      { status: 503 }
    );
  }
}