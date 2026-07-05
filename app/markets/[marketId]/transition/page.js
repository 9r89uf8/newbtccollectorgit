import Link from "next/link";
import { notFound } from "next/navigation";
import { getMarketTransitionData } from "@/lib/marketTransitionData.js";
import MarketMicrostructureChart from "../MarketMicrostructureChart.js";

export const dynamic = "force-dynamic";

function formatUtc(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date) + " UTC";
}

function formatShortUtc(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date) + " UTC";
}

function formatPct(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${number >= 0 ? "+" : ""}${number.toFixed(4)}%`;
}

function formatClassName(value) {
  if (!value) return "-";
  return String(value).replaceAll("_", " ");
}

function statusClass(status) {
  if (status === "running" || status === "closed" || status === "complete") return "status-good";
  if (status === "open" || status === "partial" || status === "late_start" || status === "stale") return "status-warn";
  if (status === "error" || status === "incomplete" || status === "missing") return "status-bad";
  return "status-muted";
}

function directionClass(direction) {
  if (direction === "up") return "direction-up";
  if (direction === "down") return "direction-down";
  return "direction-flat";
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function toChartNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function SetupState({ error, configured }) {
  return (
    <section className="setup-state">
      <div>
        <p className="eyebrow">Setup required</p>
        <h1>Market transition</h1>
        <p className="setup-copy">
          {configured
            ? "The app found a database setting, but it could not query the transition data."
            : "Add DATABASE_URL, run the schema setup, then start the collector process."}
        </p>
      </div>
      <p className="error-text">{error}</p>
    </section>
  );
}

function TransitionMetric({ label, value, tone = "default" }) {
  return (
    <div className={`metric metric-${tone}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value detail-metric-value">{value}</div>
    </div>
  );
}

function marketHref(marketId) {
  return `/markets/${encodeURIComponent(marketId)}`;
}

function MarketBoundaryTable({ previousMarket, currentMarket, windowStart, boundaryTime, windowEnd }) {
  const rows = [
    previousMarket
      ? {
          label: "Previous",
          market: previousMarket,
          window: `${formatShortUtc(windowStart)} - ${formatShortUtc(boundaryTime)}`,
        }
      : null,
    {
      label: "Current",
      market: currentMarket,
      window: `${formatShortUtc(boundaryTime)} - ${formatShortUtc(windowEnd)}`,
    },
  ].filter(Boolean);

  return (
    <section className="panel table-panel detail-wide-panel">
      <div className="panel-heading">
        <div>
          <p className="panel-label">Boundary markets</p>
          <h2>Previous last minute and current first minute</h2>
        </div>
      </div>
      {!previousMarket ? (
        <p className="muted transition-note">No earlier market was found for this symbol before the current market.</p>
      ) : null}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Segment</th>
              <th>Displayed window</th>
              <th>Market</th>
              <th>Status</th>
              <th>5m move</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ label, market, window }) => (
              <tr key={market.id}>
                <td><strong>{label}</strong></td>
                <td>{window}</td>
                <td>
                  <Link className="market-link" href={marketHref(market.id)}>{formatUtc(market.start_time)}</Link>
                  <span className="subtext">{market.id}</span>
                </td>
                <td><span className={`status-pill ${statusClass(market.status)}`}>{market.status}</span></td>
                <td className={directionClass(market.binance_futures_direction)}>{formatPct(market.binance_futures_return_pct)}</td>
                <td className={directionClass(market.polymarket_direction)}>
                  {formatClassName(market.polymarket_direction || market.polymarket_winning_outcome)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default async function MarketTransitionPage({ params }) {
  const resolvedParams = await params;
  const marketId = decodeURIComponent(resolvedParams.marketId || "");
  const data = await getMarketTransitionData(marketId);

  if (!data.ok) {
    return <SetupState configured={data.configured} error={data.error} />;
  }

  if (!data.currentMarket) {
    notFound();
  }

  const chartPriceSeries = data.priceSeries.map((sample) => ({
    time: toIso(sample.scheduled_at),
    price: Number(sample.price),
  }));
  const chartBuckets = data.buckets.map((bucket) => ({
    marketId: bucket.market_id,
    bucket_start: toIso(bucket.bucket_start),
    bucket_end: toIso(bucket.bucket_end),
    total_volume_quote: toChartNumber(bucket.total_volume_quote),
    net_taker_quote: toChartNumber(bucket.net_taker_quote),
    cvd_market_quote: toChartNumber(bucket.cvd_market_quote),
    taker_imbalance: toChartNumber(bucket.taker_imbalance),
    book_imbalance_5bps: toChartNumber(bucket.book_imbalance_5bps),
    spread_bps: toChartNumber(bucket.spread_bps),
  }));
  const chartTradeFlow1s = data.tradeFlow1s.map((bucket) => ({
    marketId: bucket.market_id,
    bucket_start: toIso(bucket.bucket_start),
    bucket_end: toIso(bucket.bucket_end),
    gross_taker_quote: toChartNumber(bucket.gross_taker_quote),
    net_taker_quote: toChartNumber(bucket.net_taker_quote),
    cvd_market_quote: toChartNumber(bucket.cvd_market_quote),
    taker_imbalance: toChartNumber(bucket.taker_imbalance),
    rolling_net_30s: toChartNumber(bucket.rolling_net_30s),
    rolling_gross_30s: toChartNumber(bucket.rolling_gross_30s),
    rolling_imbalance_30s: toChartNumber(bucket.rolling_imbalance_30s),
  }));
  const chartPositionSeries = data.positionSeries.map((sample) => ({
    time: toIso(sample.scheduled_at),
    open_interest_quote: Number(sample.open_interest_quote),
    premium_bps: Number(sample.premium_bps),
    funding_rate: Number(sample.funding_rate),
  }));
  const chartWebSocketSummaries = data.webSocketSummaries.map((summary) => ({
    bucket_start: toIso(summary.bucket_start),
    mid_price_close: toChartNumber(summary.mid_price_close),
    spread_bps_avg: toChartNumber(summary.spread_bps_avg),
    spread_bps_max: toChartNumber(summary.spread_bps_max),
    liquidation_net_quote: toChartNumber(summary.liquidation_net_quote),
    book_ticker_update_count: toChartNumber(summary.book_ticker_update_count),
    mid_price_move_count: toChartNumber(summary.mid_price_move_count),
    microprice_bps_from_mid_close: toChartNumber(summary.microprice_bps_from_mid_close),
    avg_event_lag_ms: toChartNumber(summary.avg_event_lag_ms),
  }));
  const chartMicropriceBuckets = data.micropriceBuckets.map((bucket) => ({
    marketId: bucket.market_id,
    bucket_start: toIso(bucket.bucket_start),
    microprice_lean: toChartNumber(bucket.microprice_lean),
    lean_delta_1s: toChartNumber(bucket.lean_delta_1s),
    ewma_lean_3s: toChartNumber(bucket.ewma_lean_3s),
    avg_lean_5s: toChartNumber(bucket.avg_lean_5s),
    avg_lean_10s: toChartNumber(bucket.avg_lean_10s),
    avg_lean_30s: toChartNumber(bucket.avg_lean_30s),
    microprice_pressure_market: toChartNumber(bucket.microprice_pressure_market),
    persistence_signal: bucket.persistence_signal,
    microprice_behavior: bucket.microprice_behavior,
  }));
  const chartPolymarketProbabilities = data.polymarketProbabilitySeries.map((sample) => ({
    marketId: sample.market_id,
    time: toIso(sample.scheduled_at),
    up_probability: toChartNumber(sample.up_probability),
    down_probability: toChartNumber(sample.down_probability),
  }));
  const sampledChainlinkPriceSeries = data.chainlinkPriceSeries.map((sample) => ({
    marketId: sample.market_id,
    time: toIso(sample.scheduled_at),
    price: toChartNumber(sample.price),
  })).filter((sample) => sample.price !== null);
  const settlementChainlinkPriceSeries = [
    data.previousMarket
      ? {
          marketId: data.previousMarket.id,
          time: toIso(data.previousMarket.end_time),
          price: toChartNumber(data.previousMarket.polymarket_close_price),
        }
      : null,
    {
      marketId: data.currentMarket.id,
      time: toIso(data.currentMarket.start_time),
      price: toChartNumber(data.currentMarket.polymarket_open_price),
    },
  ].filter((sample) => sample && sample.price !== null);
  const chartChainlinkPriceSeries = [
    ...sampledChainlinkPriceSeries,
    ...settlementChainlinkPriceSeries,
  ].sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime());

  return (
    <main className="dashboard-shell market-detail-shell">
      <header className="dashboard-header detail-header">
        <div>
          <Link className="back-link" href={marketHref(data.currentMarket.id)}>Back to full market</Link>
          <p className="eyebrow">Market transition</p>
          <h1>{formatUtc(data.boundaryTime)}</h1>
          <p className="detail-market-id">{data.currentMarket.id}</p>
        </div>
        <div className="heartbeat-meta">
          <span className="status-pill status-muted">2 minute view</span>
          <span>{data.currentMarket.symbol}</span>
        </div>
      </header>

      <section className="metrics-grid detail-metrics-grid">
        <TransitionMetric label="Previous market" value={data.previousMarket ? formatShortUtc(data.previousMarket.start_time) : "Missing"} tone={data.previousMarket ? "default" : "warn"} />
        <TransitionMetric label="Current market" value={formatShortUtc(data.currentMarket.start_time)} />
        <TransitionMetric label="Boundary" value={formatShortUtc(data.boundaryTime)} />
        <TransitionMetric label="BTC samples" value={chartPriceSeries.length} />
      </section>

      <section className="panel chart-panel detail-wide-panel">
        <div className="panel-heading">
          <div>
            <p className="panel-label">Transition chart</p>
            <h2>Previous market last minute, boundary, and current market first minute</h2>
          </div>
          <span className="status-pill status-muted">{formatShortUtc(data.windowStart)} - {formatShortUtc(data.windowEnd)}</span>
        </div>
        <div className="transition-chart-frame" aria-label="Market boundary at chart midpoint">
          <MarketMicrostructureChart
            marketStart={toIso(data.windowStart)}
            marketEnd={toIso(data.windowEnd)}
            priceSeries={chartPriceSeries}
            buckets={chartBuckets}
            tradeFlow1s={chartTradeFlow1s}
            positionSeries={chartPositionSeries}
            webSocketSummaries={chartWebSocketSummaries}
            micropriceBuckets={chartMicropriceBuckets}
            polymarketProbabilities={chartPolymarketProbabilities}
            chainlinkPriceSeries={chartChainlinkPriceSeries}
          />
        </div>
      </section>

      <MarketBoundaryTable
        previousMarket={data.previousMarket}
        currentMarket={data.currentMarket}
        windowStart={data.windowStart}
        boundaryTime={data.boundaryTime}
        windowEnd={data.windowEnd}
      />
    </main>
  );
}
