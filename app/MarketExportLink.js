function marketExportHref(marketId) {
  return `/api/markets/${encodeURIComponent(marketId)}/llm-export`;
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
