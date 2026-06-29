import Link from "next/link";
import { notFound } from "next/navigation";
import { getMarketDetailData } from "@/lib/marketDetailData.js";
import MarketMicrostructureChart from "./MarketMicrostructureChart.js";

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

function formatPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(number);
}

function formatCompactUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(number);
}

function formatPct(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${number >= 0 ? "+" : ""}${number.toFixed(4)}%`;
}

function formatDecimal(value, digits = 3) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${number >= 0 ? "+" : ""}${number.toFixed(digits)}`;
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return new Intl.NumberFormat("en-US").format(number);
}

function formatSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${number}s`;
}

function formatBps(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${number >= 0 ? "+" : ""}${number.toFixed(digits)} bps`;
}

function formatConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${Math.round(number * 100)}%`;
}

function formatClassName(value) {
  if (!value) return "-";
  return String(value).replaceAll("_", " ");
}

function statusClass(status) {
  if (status === "running" || status === "closed" || status === "complete") return "status-good";
  if (status === "open" || status === "partial" || status === "late_start") return "status-warn";
  if (status === "error" || status === "incomplete" || status === "missing") return "status-bad";
  return "status-muted";
}

function directionClass(direction) {
  if (direction === "up") return "direction-up";
  if (direction === "down") return "direction-down";
  return "direction-flat";
}

function signedClass(value) {
  const number = Number(value);
  if (number > 0) return "number-positive";
  if (number < 0) return "number-negative";
  return "direction-flat";
}

function SetupState({ error, configured }) {
  return (
    <section className="setup-state">
      <div>
        <p className="eyebrow">Setup required</p>
        <h1>Market detail</h1>
        <p className="setup-copy">
          {configured
            ? "The app found a database setting, but it could not query the market detail tables."
            : "Add DATABASE_URL, run the schema setup, then start the collector process."}
        </p>
      </div>
      <p className="error-text">{error}</p>
    </section>
  );
}

function DetailMetric({ label, value, tone = "default" }) {
  return (
    <div className={`metric metric-${tone}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value detail-metric-value">{value}</div>
    </div>
  );
}

function LabelTable({ labels }) {
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <div>
          <p className="panel-label">Labels</p>
          <h2>Open and close results</h2>
        </div>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Open</th>
              <th>Close</th>
              <th>Return</th>
              <th>Samples</th>
              <th>Quality</th>
            </tr>
          </thead>
          <tbody>
            {labels.length === 0 ? (
              <tr>
                <td colSpan="6" className="empty-cell">No labels for this market.</td>
              </tr>
            ) : (
              labels.map((label) => (
                <tr key={label.source}>
                  <td>{label.source}</td>
                  <td>{formatPrice(label.open_price)}</td>
                  <td>{formatPrice(label.close_price)}</td>
                  <td className={directionClass(label.direction)}>{formatPct(label.return_pct)}</td>
                  <td>{label.sample_count}</td>
                  <td><span className={`status-pill ${statusClass(label.quality)}`}>{label.quality}</span></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ClassificationSummary({ classification, behaviorLabel, positionFeature }) {
  const reasons = Array.isArray(classification?.reasons) ? classification.reasons : [];
  const tags = Array.isArray(classification?.secondary_tags) ? classification.secondary_tags : [];

  return (
    <section className="panel stats-panel detail-wide-panel">
      <div className="panel-heading">
        <div>
          <p className="panel-label">Classification</p>
          <h2>Market behavior class</h2>
        </div>
        {classification ? <span className="status-pill status-muted">{formatConfidence(classification.confidence)}</span> : null}
      </div>
      {!classification ? (
        <p className="muted">No classification row yet.</p>
      ) : (
        <>
          <div className="detail-feature-grid">
            <div>
              <span>Class</span>
              <strong>{formatClassName(classification.primary_class)}</strong>
            </div>
            <div>
              <span>Shape</span>
              <strong>{formatClassName(behaviorLabel?.shape_class)}</strong>
            </div>
            <div>
              <span>Range</span>
              <strong>{formatBps(behaviorLabel?.range_bps)}</strong>
            </div>
            <div>
              <span>OI change</span>
              <strong className={signedClass(positionFeature?.open_interest_change_pct)}>{formatPct(positionFeature?.open_interest_change_pct)}</strong>
            </div>
            <div>
              <span>Premium change</span>
              <strong className={signedClass(positionFeature?.premium_bps_change)}>{formatBps(positionFeature?.premium_bps_change)}</strong>
            </div>
            <div>
              <span>Positioning</span>
              <strong>{positionFeature ? positionFeature.position_quality : "missing"}</strong>
            </div>
          </div>
          {reasons.length > 0 ? <p className="feature-footnote">{reasons.join(" ")}</p> : null}
          {tags.length > 0 ? <p className="feature-footnote">{tags.map(formatClassName).join(", ")}</p> : null}
        </>
      )}
    </section>
  );
}

function FeatureSummary({ features }) {
  const feature = features[0] || null;

  return (
    <section className="panel stats-panel feature-detail-panel">
      <div className="panel-heading">
        <div>
          <p className="panel-label">Futures summary</p>
          <h2>5 minute flow and liquidity</h2>
        </div>
        {feature ? <span className={`status-pill ${statusClass(feature.feature_quality)}`}>{feature.feature_quality}</span> : null}
      </div>
      {!feature ? (
        <p className="muted">No market feature row yet.</p>
      ) : (
        <div className="detail-feature-grid">
          <div>
            <span>Net taker</span>
            <strong className={signedClass(feature.net_taker_quote)}>{formatCompactUsd(feature.net_taker_quote)}</strong>
          </div>
          <div>
            <span>Taker imb.</span>
            <strong className={signedClass(feature.taker_imbalance)}>{formatDecimal(feature.taker_imbalance)}</strong>
          </div>
          <div>
            <span>Book imb.</span>
            <strong className={signedClass(feature.avg_book_imbalance_5bps)}>{formatDecimal(feature.avg_book_imbalance_5bps)}</strong>
          </div>
          <div>
            <span>Avg spread</span>
            <strong>{formatDecimal(feature.avg_spread_bps, 2)}</strong>
          </div>
          <div>
            <span>Trades</span>
            <strong>{formatNumber(feature.agg_trade_count)}</strong>
          </div>
          <div>
            <span>Book samples</span>
            <strong>{formatNumber(feature.book_sample_count)}</strong>
          </div>
        </div>
      )}
    </section>
  );
}

function sumNumeric(rows, field) {
  return rows.reduce((total, row) => {
    const number = Number(row[field]);
    return Number.isFinite(number) ? total + number : total;
  }, 0);
}

function averageNumeric(rows, field) {
  let total = 0;
  let count = 0;
  for (const row of rows) {
    const number = Number(row[field]);
    if (Number.isFinite(number)) {
      total += number;
      count += 1;
    }
  }
  return count > 0 ? total / count : null;
}

function readFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function polymarketCoverageQuality(coverage) {
  if (!coverage) return "missing";

  const expectedCount = readFiniteNumber(coverage.expected_count) || 0;
  const sampleCount = readFiniteNumber(coverage.sample_count) || 0;
  const completeCount = readFiniteNumber(coverage.complete_count) || 0;
  const missingCount = readFiniteNumber(coverage.missing_count) || 0;
  const partialCount = readFiniteNumber(coverage.partial_count) || 0;
  const missingQualityCount = readFiniteNumber(coverage.missing_quality_count) || 0;
  const firstLagSeconds = readFiniteNumber(coverage.first_sample_lag_seconds);

  if (sampleCount === 0) return "missing";
  if (firstLagSeconds !== null && firstLagSeconds > 0) return "late_start";
  if (sampleCount < expectedCount || missingCount > 0 || partialCount > 0 || missingQualityCount > 0) return "partial";
  return completeCount >= expectedCount ? "complete" : "partial";
}

function formatSampleRatio(sampleCount, expectedCount) {
  const sample = readFiniteNumber(sampleCount);
  const expected = readFiniteNumber(expectedCount);
  if (sample === null || expected === null) return "-";
  return `${formatNumber(sample)}/${formatNumber(expected)}`;
}

function PolymarketCoveragePanel({ coverage }) {
  const quality = polymarketCoverageQuality(coverage);

  return (
    <section className="panel stats-panel detail-wide-panel">
      <div className="panel-heading">
        <div>
          <p className="panel-label">Polymarket timing</p>
          <h2>Probability sample coverage</h2>
        </div>
        <span className={`status-pill ${statusClass(quality)}`}>{formatClassName(quality)}</span>
      </div>
      {!coverage ? (
        <p className="muted">No Polymarket probability coverage row yet.</p>
      ) : (
        <div className="detail-feature-grid">
          <div>
            <span>Samples</span>
            <strong>{formatSampleRatio(coverage.sample_count, coverage.expected_count)}</strong>
          </div>
          <div>
            <span>Complete rows</span>
            <strong>{formatNumber(coverage.complete_count)}</strong>
          </div>
          <div>
            <span>Missing slots</span>
            <strong>{formatNumber(coverage.missing_count)}</strong>
          </div>
          <div>
            <span>Partial rows</span>
            <strong>{formatNumber(coverage.partial_count)}</strong>
          </div>
          <div>
            <span>First sample</span>
            <strong>{formatUtc(coverage.first_sample_at)}</strong>
          </div>
          <div>
            <span>First lag</span>
            <strong>{formatSeconds(coverage.first_sample_lag_seconds)}</strong>
          </div>
        </div>
      )}
    </section>
  );
}

function WebSocketSummaryPanel({ summaries, forwardLabelStats }) {
  const bookUpdates = sumNumeric(summaries, "book_ticker_update_count");
  const liquidationCount = sumNumeric(summaries, "liquidation_count");
  const netLiquidation = sumNumeric(summaries, "liquidation_net_quote");
  const avgSpread = averageNumeric(summaries, "spread_bps_avg");

  return (
    <details className="panel table-panel detail-wide-panel collapsible-panel">
      <summary className="panel-heading collapsible-panel-summary">
        <div>
          <p className="panel-label">WebSocket summaries</p>
          <h2>1 second book and liquidation rows</h2>
        </div>
        <div className="collapsible-panel-actions">
          <span className="status-pill status-muted">{summaries.length} rows</span>
          <span className="collapsible-toggle" aria-hidden="true">
            <span className="collapsible-toggle-show">Show</span>
            <span className="collapsible-toggle-hide">Hide</span>
          </span>
        </div>
      </summary>

      <div className="collapsible-panel-body">
        <div className="detail-feature-grid">
          <div>
            <span>Book updates</span>
            <strong>{formatNumber(bookUpdates)}</strong>
          </div>
          <div>
            <span>Liquidations</span>
            <strong>{formatNumber(liquidationCount)}</strong>
          </div>
          <div>
            <span>Net liq</span>
            <strong className={signedClass(netLiquidation)}>{formatCompactUsd(netLiquidation)}</strong>
          </div>
          <div>
            <span>Avg spread</span>
            <strong>{formatBps(avgSpread)}</strong>
          </div>
        </div>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Horizon</th>
              <th>Quality</th>
              <th>Direction</th>
              <th>Labels</th>
              <th>Avg return</th>
              <th>Avg max up</th>
              <th>Avg max down</th>
            </tr>
          </thead>
          <tbody>
            {forwardLabelStats.length === 0 ? (
              <tr>
                <td colSpan="7" className="empty-cell">No forward labels for this market.</td>
              </tr>
            ) : (
              forwardLabelStats.map((row) => (
                <tr key={`${row.horizon_seconds}-${row.quality}-${row.direction_label}`}>
                  <td>{row.horizon_seconds}s</td>
                  <td><span className={`status-pill ${statusClass(row.quality)}`}>{row.quality}</span></td>
                  <td className={directionClass(row.direction_label)}>{row.direction_label}</td>
                  <td>{formatNumber(row.count)}</td>
                  <td className={signedClass(row.avg_forward_return_bps)}>{formatBps(row.avg_forward_return_bps)}</td>
                  <td className={signedClass(row.avg_future_max_up_bps)}>{formatBps(row.avg_future_max_up_bps)}</td>
                  <td className={signedClass(row.avg_future_max_down_bps)}>{formatBps(row.avg_future_max_down_bps)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="table-scroll">
        <table className="bucket-detail-table">
          <thead>
            <tr>
              <th>Second</th>
              <th>Mid</th>
              <th>1s move</th>
              <th>Spread avg</th>
              <th>Spread max</th>
              <th>Book updates</th>
              <th>Mid moves</th>
              <th>Net liq</th>
              <th>Max liq</th>
              <th>Lag</th>
              <th>Quality</th>
            </tr>
          </thead>
          <tbody>
            {summaries.length === 0 ? (
              <tr>
                <td colSpan="11" className="empty-cell">No WebSocket summaries for this market.</td>
              </tr>
            ) : (
              summaries.map((summary) => (
                <tr key={summary.bucket_start}>
                  <td>{formatUtc(summary.bucket_start)}</td>
                  <td>{formatPrice(summary.mid_price_close)}</td>
                  <td className={signedClass(summary.mid_return_bps)}>{formatBps(summary.mid_return_bps)}</td>
                  <td>{formatBps(summary.spread_bps_avg)}</td>
                  <td>{formatBps(summary.spread_bps_max)}</td>
                  <td>{formatNumber(summary.book_ticker_update_count)}</td>
                  <td>{formatNumber(summary.mid_price_move_count)}</td>
                  <td className={signedClass(summary.liquidation_net_quote)}>{formatCompactUsd(summary.liquidation_net_quote)}</td>
                  <td>{formatCompactUsd(summary.liquidation_max_quote)}</td>
                  <td>{summary.avg_event_lag_ms ? `${Number(summary.avg_event_lag_ms).toFixed(0)} ms` : "-"}</td>
                  <td><span className={`status-pill ${statusClass(summary.summary_quality)}`}>{summary.summary_quality}</span></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      </div>
    </details>
  );
}
function BucketTable({ buckets }) {
  return (
    <details className="panel table-panel detail-wide-panel collapsible-panel">
      <summary className="panel-heading collapsible-panel-summary">
        <div>
          <p className="panel-label">Timestamp buckets</p>
          <h2>Interval-by-interval explanation</h2>
        </div>
        <div className="collapsible-panel-actions">
          <span className="status-pill status-muted">{buckets.length} rows</span>
          <span className="collapsible-toggle" aria-hidden="true">
            <span className="collapsible-toggle-show">Show</span>
            <span className="collapsible-toggle-hide">Hide</span>
          </span>
        </div>
      </summary>
      <div className="collapsible-panel-body">
        <div className="table-scroll">
        <table className="bucket-detail-table">
          <thead>
            <tr>
              <th>Start</th>
              <th>Window</th>
              <th>Move</th>
              <th>Net taker</th>
              <th>Taker imb.</th>
              <th>Book imb.</th>
              <th>Spread</th>
              <th>Trades</th>
              <th>Bid 5bps</th>
              <th>Ask 5bps</th>
              <th>Quality</th>
            </tr>
          </thead>
          <tbody>
            {buckets.length === 0 ? (
              <tr>
                <td colSpan="11" className="empty-cell">No timestamp buckets for this market.</td>
              </tr>
            ) : (
              buckets.map((bucket) => (
                <tr key={`${bucket.source}-${bucket.bucket_start}`}>
                  <td>{formatUtc(bucket.bucket_start)}</td>
                  <td>{Number(bucket.bucket_seconds).toFixed(0)}s</td>
                  <td className={directionClass(bucket.direction)}>{formatPct(bucket.return_pct)}</td>
                  <td className={signedClass(bucket.net_taker_quote)}>{formatCompactUsd(bucket.net_taker_quote)}</td>
                  <td className={signedClass(bucket.taker_imbalance)}>{formatDecimal(bucket.taker_imbalance)}</td>
                  <td className={signedClass(bucket.book_imbalance_5bps)}>{formatDecimal(bucket.book_imbalance_5bps)}</td>
                  <td>{formatDecimal(bucket.spread_bps, 2)}</td>
                  <td>{formatNumber(bucket.agg_trade_count)}</td>
                  <td>{formatCompactUsd(bucket.bid_depth_5bps)}</td>
                  <td>{formatCompactUsd(bucket.ask_depth_5bps)}</td>
                  <td><span className={`status-pill ${statusClass(bucket.bucket_quality)}`}>{bucket.bucket_quality}</span></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        </div>
      </div>
    </details>
  );
}

function SampleStats({ rows }) {
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <div>
          <p className="panel-label">Samples</p>
          <h2>Price sample coverage</h2>
        </div>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Samples</th>
              <th>First</th>
              <th>Last</th>
              <th>Min price</th>
              <th>Max price</th>
              <th>Avg latency</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan="7" className="empty-cell">No sample stats for this market.</td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.source}>
                  <td>{row.source}</td>
                  <td>{row.sample_count}</td>
                  <td>{formatUtc(row.first_sample_at)}</td>
                  <td>{formatUtc(row.last_sample_at)}</td>
                  <td>{formatPrice(row.min_price)}</td>
                  <td>{formatPrice(row.max_price)}</td>
                  <td>{row.avg_latency_ms ? `${row.avg_latency_ms} ms` : "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TopTrades({ trades }) {
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <div>
          <p className="panel-label">Trades</p>
          <h2>Largest futures aggregate trades</h2>
        </div>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Side</th>
              <th>Notional</th>
              <th>Price</th>
              <th>Qty</th>
            </tr>
          </thead>
          <tbody>
            {trades.length === 0 ? (
              <tr>
                <td colSpan="5" className="empty-cell">No aggregate trades for this market.</td>
              </tr>
            ) : (
              trades.map((trade) => (
                <tr key={trade.agg_trade_id}>
                  <td>{formatUtc(trade.trade_time)}</td>
                  <td className={trade.taker_side === "buy" ? "number-positive" : "number-negative"}>{trade.taker_side}</td>
                  <td>{formatCompactUsd(trade.quote_notional)}</td>
                  <td>{formatPrice(trade.price)}</td>
                  <td>{formatNumber(trade.quantity)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ErrorList({ errors }) {
  return (
    <section className="panel error-panel">
      <div className="panel-heading">
        <div>
          <p className="panel-label">Errors</p>
          <h2>Market collection errors</h2>
        </div>
      </div>
      {errors.length === 0 ? (
        <p className="muted">No errors recorded for this market.</p>
      ) : (
        <div className="error-list">
          {errors.map((error) => (
            <div className="error-item" key={`${error.time}-${error.source}-${error.message}`}>
              <div>
                <strong>{error.source || "collector"}</strong>
                <p>{error.message}</p>
              </div>
              <span>{formatUtc(error.time)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default async function MarketDetailPage({ params }) {
  const resolvedParams = await params;
  const marketId = decodeURIComponent(resolvedParams.marketId || "");
  const data = await getMarketDetailData(marketId);

  if (!data.ok) {
    return <SetupState configured={data.configured} error={data.error} />;
  }

  if (!data.market) {
    notFound();
  }

  const futuresLabel = data.labels.find((label) => label.source === "binance_futures");
  const classification = data.classifications[0] || null;
  const behaviorLabel = data.behaviorLabels[0] || null;
  const positionFeature = data.positionFeatures[0] || null;
  const chartPriceSeries = data.priceSeries.map((sample) => ({
    time: sample.scheduled_at instanceof Date ? sample.scheduled_at.toISOString() : sample.scheduled_at,
    price: Number(sample.price),
  }));
  const chartBuckets = data.buckets.map((bucket) => ({
    bucket_start: bucket.bucket_start instanceof Date ? bucket.bucket_start.toISOString() : bucket.bucket_start,
    net_taker_quote: Number(bucket.net_taker_quote),
    taker_imbalance: Number(bucket.taker_imbalance),
    book_imbalance_5bps: Number(bucket.book_imbalance_5bps),
    spread_bps: Number(bucket.spread_bps),
  }));
  const chartPositionSeries = data.positionSeries.map((sample) => ({
    time: sample.scheduled_at instanceof Date ? sample.scheduled_at.toISOString() : sample.scheduled_at,
    open_interest_quote: Number(sample.open_interest_quote),
    premium_bps: Number(sample.premium_bps),
    funding_rate: Number(sample.funding_rate),
  }));
  const toChartNumber = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const chartWebSocketSummaries = data.webSocketSummaries.map((summary) => ({
    bucket_start: summary.bucket_start instanceof Date ? summary.bucket_start.toISOString() : summary.bucket_start,
    mid_price_close: toChartNumber(summary.mid_price_close),
    spread_bps_avg: toChartNumber(summary.spread_bps_avg),
    spread_bps_max: toChartNumber(summary.spread_bps_max),
    liquidation_net_quote: toChartNumber(summary.liquidation_net_quote),
    book_ticker_update_count: toChartNumber(summary.book_ticker_update_count),
    mid_price_move_count: toChartNumber(summary.mid_price_move_count),
    microprice_bps_from_mid_close: toChartNumber(summary.microprice_bps_from_mid_close),
    avg_event_lag_ms: toChartNumber(summary.avg_event_lag_ms),
  }));
  const chartPolymarketProbabilities = data.polymarketProbabilitySeries.map((sample) => ({
    time: sample.scheduled_at instanceof Date ? sample.scheduled_at.toISOString() : sample.scheduled_at,
    up_probability: toChartNumber(sample.up_probability),
    down_probability: toChartNumber(sample.down_probability),
  }));

  return (
    <main className="dashboard-shell market-detail-shell">
      <header className="dashboard-header detail-header">
        <div>
          <Link className="back-link" href="/">Back to dashboard</Link>
          <p className="eyebrow">Market detail</p>
          <h1>{formatUtc(data.market.start_time)}</h1>
          <p className="detail-market-id">{data.market.id}</p>
        </div>
        <div className="heartbeat-meta">
          <span className={`status-pill ${statusClass(data.market.status)}`}>{data.market.status}</span>
          <span>{data.market.symbol}</span>
        </div>
      </header>

      <section className="metrics-grid detail-metrics-grid">
        <DetailMetric label="Window end" value={formatUtc(data.market.end_time)} />
        <DetailMetric label="Futures return" value={formatPct(futuresLabel?.return_pct)} tone={futuresLabel?.direction === "up" ? "good" : futuresLabel?.direction === "down" ? "bad" : "default"} />
        <DetailMetric label="Market class" value={formatClassName(classification?.primary_class)} />
        <DetailMetric label="Buckets" value={data.buckets.length} />
      </section>

      <ClassificationSummary
        classification={classification}
        behaviorLabel={behaviorLabel}
        positionFeature={positionFeature}
      />

      <div className="detail-grid">
        <LabelTable labels={data.labels} />
        <FeatureSummary features={data.features} />
      </div>

      <PolymarketCoveragePanel coverage={data.polymarketCoverage} />

      <section className="panel chart-panel detail-wide-panel">
        <div className="panel-heading">
          <div>
            <p className="panel-label">BTC futures price</p>
            <h2>Price, taker flow, WebSocket liquidity, spread, and positioning</h2>
          </div>
          <span className="status-pill status-muted">{chartPriceSeries.length} samples</span>
        </div>
        <MarketMicrostructureChart
          marketStart={data.market.start_time instanceof Date ? data.market.start_time.toISOString() : data.market.start_time}
          marketEnd={data.market.end_time instanceof Date ? data.market.end_time.toISOString() : data.market.end_time}
          priceSeries={chartPriceSeries}
          buckets={chartBuckets}
          positionSeries={chartPositionSeries}
          webSocketSummaries={chartWebSocketSummaries}
          polymarketProbabilities={chartPolymarketProbabilities}
        />
      </section>

      <WebSocketSummaryPanel
        summaries={data.webSocketSummaries}
        forwardLabelStats={data.forwardLabelStats}
      />

      <BucketTable buckets={data.buckets} />

      <div className="detail-grid">
        <SampleStats rows={data.sampleStats} />
        <TopTrades trades={data.topTrades} />
      </div>

      <ErrorList errors={data.errors} />
    </main>
  );
}
