import Link from "next/link";
import { getMarketsForUtcDay } from "@/lib/marketListData.js";

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

function formatUtcDate(value) {
  if (!value) return "-";
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "2-digit",
    year: "numeric",
  }).format(date);
}

function statusClass(status) {
  if (status === "running" || status === "closed" || status === "complete") return "status-good";
  if (status === "open" || status === "partial") return "status-warn";
  if (status === "error" || status === "incomplete" || status === "missing") return "status-bad";
  return "status-muted";
}

function directionClass(direction) {
  if (direction === "up") return "direction-up";
  if (direction === "down") return "direction-down";
  return "direction-flat";
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

function formatPct(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${number >= 0 ? "+" : ""}${number.toFixed(4)}%`;
}

function formatClassName(value) {
  if (!value) return "-";
  return String(value).replaceAll("_", " ");
}

function referenceQuality(openPrice, closePrice) {
  const hasOpen = Number.isFinite(Number(openPrice));
  const hasClose = Number.isFinite(Number(closePrice));
  if (hasOpen && hasClose) return "complete";
  if (hasOpen || hasClose) return "partial";
  return "missing";
}

function PricePair({ openPrice, closePrice }) {
  const hasOpen = Number.isFinite(Number(openPrice));
  const hasClose = Number.isFinite(Number(closePrice));
  if (!hasOpen && !hasClose) return "-";

  return (
    <div className="price-pair">
      <strong>{formatPrice(closePrice)}</strong>
      <span className="subtext">open {formatPrice(openPrice)}</span>
    </div>
  );
}

function SetupState({ error, configured }) {
  return (
    <section className="setup-state">
      <div>
        <p className="eyebrow">Setup required</p>
        <h1>Markets</h1>
        <p className="setup-copy">
          {configured
            ? "The app found a database setting, but it could not query the market list."
            : "Add DATABASE_URL, run the schema setup, then start the collector process."}
        </p>
      </div>
      <p className="error-text">{error}</p>
    </section>
  );
}

function SummaryMetric({ label, value, tone = "default" }) {
  return (
    <div className={`metric metric-${tone}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value detail-metric-value">{value}</div>
    </div>
  );
}

function LabelQuality({ labels }) {
  if (!labels || labels.length === 0) {
    return <span className="status-pill status-muted">missing</span>;
  }

  return (
    <div className="market-quality-list">
      {labels.map((label) => (
        <div className="quality-chip-row" key={`${label.source}-${label.quality}`}>
          <span>{label.source}</span>
          <span className={`status-pill ${statusClass(label.quality)}`}>{label.quality || "missing"}</span>
        </div>
      ))}
    </div>
  );
}

export default async function MarketsPage({ searchParams }) {
  const resolvedSearchParams = await searchParams;
  const dayValue = Array.isArray(resolvedSearchParams?.day)
    ? resolvedSearchParams.day[0]
    : resolvedSearchParams?.day;
  const data = await getMarketsForUtcDay(dayValue);

  if (!data.ok) {
    return <SetupState configured={data.configured} error={data.error} />;
  }

  const summary = data.summary || {};

  return (
    <main className="dashboard-shell market-list-shell">
      <header className="dashboard-header detail-header">
        <div>
          <Link className="back-link" href="/">Back to dashboard</Link>
          <p className="eyebrow">Markets</p>
          <h1>{formatUtcDate(data.day)}</h1>
        </div>
        <div className="heartbeat-meta">
          <span className="status-pill status-muted">UTC day</span>
          <span>{data.day}</span>
        </div>
      </header>

      <section className="metrics-grid detail-metrics-grid">
        <SummaryMetric label="Markets" value={summary.markets_total ?? 0} />
        <SummaryMetric label="Closed" value={summary.closed_count ?? 0} tone="good" />
        <SummaryMetric label="Open" value={summary.open_count ?? 0} tone="warn" />
        <SummaryMetric label="Incomplete" value={summary.incomplete_count ?? 0} tone="bad" />
      </section>

      <section className="panel table-panel">
        <div className="panel-heading">
          <div>
            <p className="panel-label">Daily markets</p>
            <h2>Timestamp and quality</h2>
          </div>
        </div>
        <div className="table-scroll">
          <table className="market-list-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Market quality</th>
                <th>Binance Futures BTC</th>
                <th>Binance move</th>
                <th>Polymarket BTC</th>
                <th>Polymarket outcome</th>
                <th>Label quality</th>
              </tr>
            </thead>
            <tbody>
              {data.markets.length === 0 ? (
                <tr>
                  <td colSpan="7" className="empty-cell">No markets for this UTC day.</td>
                </tr>
              ) : (
                data.markets.map((market) => {
                  const polymarketQuality = referenceQuality(
                    market.polymarket_open_price,
                    market.polymarket_close_price
                  );

                  return (
                    <tr key={market.id}>
                      <td>
                        <Link className="market-link" href={`/markets/${encodeURIComponent(market.id)}`}>
                          {formatUtc(market.start_time)}
                        </Link>
                        <span className="subtext">{market.symbol}</span>
                      </td>
                      <td><span className={`status-pill ${statusClass(market.status)}`}>{market.status}</span></td>
                      <td>
                        <PricePair
                          openPrice={market.binance_futures_open_price}
                          closePrice={market.binance_futures_close_price}
                        />
                      </td>
                      <td className={directionClass(market.binance_futures_direction)}>{formatPct(market.binance_futures_return_pct)}</td>
                      <td>
                        <PricePair
                          openPrice={market.polymarket_open_price}
                          closePrice={market.polymarket_close_price}
                        />
                        <span className="subtext">Chainlink via Polymarket</span>
                      </td>
                      <td className={directionClass(market.polymarket_direction)}>{formatClassName(market.polymarket_direction || market.polymarket_winning_outcome)}</td>
                      <td>
                        <LabelQuality labels={market.labels} />
                        <div className="reference-quality-list">
                          <span className={`status-pill ${statusClass(polymarketQuality)}`}>chainlink {polymarketQuality}</span>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}