import { getSnapshotFallback, LIVE_COLLECTOR_URL, withPriceToBeatFallback } from "../liveData.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const response = await fetch(`${LIVE_COLLECTOR_URL}/snapshot`, {
      cache: "no-store",
    });

    if (!response.ok) {
      const fallback = await getSnapshotFallback(`collector returned HTTP ${response.status}`);
      return Response.json(fallback, {
        headers: { "cache-control": "no-store" },
      });
    }

    const snapshot = await withPriceToBeatFallback(await response.json());
    return Response.json(snapshot, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    const fallback = await getSnapshotFallback(error.message || String(error));
    return Response.json(fallback, {
      headers: { "cache-control": "no-store" },
    });
  }
}
