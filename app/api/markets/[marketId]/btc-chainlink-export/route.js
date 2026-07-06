import {
  getMarketBtcChainlinkCsvExport,
  marketBtcChainlinkCsvFilename,
} from "@/lib/marketBtcChainlinkExport.js";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  const resolvedParams = await params;
  const marketId = decodeURIComponent(resolvedParams?.marketId || "");
  const result = await getMarketBtcChainlinkCsvExport(marketId);

  if (!result.ok) {
    return Response.json(
      {
        ok: false,
        error: result.error,
      },
      { status: result.status || 500 }
    );
  }

  const filename = marketBtcChainlinkCsvFilename(marketId);
  return new Response(result.csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
