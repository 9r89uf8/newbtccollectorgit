import { getMarketLlmExport, marketPacketFilename } from "@/lib/marketPacketExport.js";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  const resolvedParams = await params;
  const marketId = decodeURIComponent(resolvedParams?.marketId || "");
  const result = await getMarketLlmExport(marketId);

  if (!result.ok) {
    return Response.json(
      {
        ok: false,
        error: result.error,
      },
      { status: result.status || 500 }
    );
  }

  const filename = marketPacketFilename(marketId);
  return new Response(JSON.stringify(result.packet, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
