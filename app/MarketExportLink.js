function marketExportHref(marketId) {
  return `/api/markets/${encodeURIComponent(marketId)}/llm-export`;
}

function marketBtcChainlinkExportHref(marketId) {
  return `/api/markets/${encodeURIComponent(marketId)}/btc-chainlink-export`;
}

export default function MarketExportLink({ marketId, compact = false }) {
  return (
    <a
      className={`download-link${compact ? " download-link-compact" : ""}`}
      href={marketExportHref(marketId)}
    >
      {compact ? "Export JSON" : "Export LLM JSON"}
    </a>
  );
}

export function MarketBtcChainlinkExportLink({ marketId, compact = false }) {
  return (
    <a
      className={`download-link${compact ? " download-link-compact" : ""}`}
      href={marketBtcChainlinkExportHref(marketId)}
    >
      {compact ? "BTC CSV" : "Export BTC/Chainlink CSV"}
    </a>
  );
}
