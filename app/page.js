import Link from "next/link";
import { getDashboardData } from "@/lib/dashboardData.js";
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

function Metric({ label, value, tone = "default" }) {
  return (
    <div className={`metric metric-${tone}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}

function SetupState({ error, configured }) {
  return (
    <section className="setup-state">
      <div>
        <p className="eyebrow">Setup required</p>
        <h1>BTC collector dashboard</h1>
        <p className="setup-copy">
          {configured
            ? "The app found a database setting, but it could not query the collector tables."
            : "Add DATABASE_URL, run the schema setup, then start the collector process."}
        </p>
      </div>
      <div className="setup-steps">
        <code>npm run db:setup</code>
        <code>npm run collector</code>
        <code>npm run dev</code>
      </div>
      <p className="error-text">{error}</p>
    </section>
  );
}

function Heartbeat({ heartbeat }) {
  if (!heartbeat) {
    return (
      <section className="panel heartbeat-panel">
        <div>
          <p className="panel-label">Collector</p>
          <h2>No heartbeat yet</h2>
        </div>
        <span className="status-pill status-muted">waiting</span>
      </section>
    );
  }

  return (
    <section className="panel heartbeat-panel">
      <div>
        <p className="panel-label">Collector</p>
        <h2>{heartbeat.collector_name}</h2>
        <p className="muted">{heartbeat.message || heartbeat.current_market_id || "running"}</p>
      </div>
      <div className="heartbeat-meta">
        <span className={`status-pill ${statusClass(heartbeat.status)}`}>{heartbeat.status}</span>
        <span>{formatUtc(heartbeat.last_seen_at)}</span>
      </div>
    </section>
  );
}

function SourceTiles({ latestSamples, sourceStats }) {
  const statsBySource = new Map(sourceStats.map((row) => [row.source, row]));

  return (
    <section className="source-grid">
      {latestSamples.length === 0 ? (
        <div className="panel empty-panel">No price samples collected yet.</div>
      ) : (
        latestSamples.map((sample) => {
          const stats = statsBySource.get(sample.source);
          return (
            <article className="panel source-card" key={sample.source}>
              <div className="source-card-top">
                <div>
                  <p className="panel-label">{sample.source}</p>
                  <h2>{formatPrice(sample.price)}</h2>
                </div>
                <span className="status-pill status-good">{sample.sample_type}</span>
              </div>
              <dl className="detail-list">
                <div>
                  <dt>Latest</dt>
                  <dd>{formatUtc(sample.scheduled_at)}</dd>
                </div>
                <div>
                  <dt>Latency</dt>
                  <dd>{sample.latency_ms} ms</dd>
                </div>
                <div>
                  <dt>1h samples</dt>
                  <dd>{stats?.samples || 0}</dd>
                </div>
                <div>
                  <dt>Avg latency</dt>
                  <dd>{stats?.avg_latency_ms ? `${stats.avg_latency_ms} ms` : "-"}</dd>
                </div>
              </dl>
            </article>
          );
        })
      )}
    </section>
  );
}

function MarketRows({ markets }) {
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <div>
          <p className="panel-label">Markets</p>
          <h2>Latest 3 five minute windows</h2>
        </div>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Window</th>
              <th>Status</th>
              <th>Source</th>
              <th>Open</th>
              <th>Close</th>
              <th>Return</th>
              <th>Samples</th>
              <th>Quality</th>
            </tr>
          </thead>
          <tbody>
            {markets.length === 0 ? (
              <tr>
                <td colSpan="8" className="empty-cell">No markets created yet.</td>
              </tr>
            ) : (
              markets.flatMap((market) => {
                const labels = market.labels.length > 0 ? market.labels : [null];
                return labels.map((label, index) => (
                  <tr key={`${market.id}-${label?.source || "empty"}`}>
                    <td>
                      {index === 0 ? (
                        <div>
                          <Link className="market-link" href={`/markets/${encodeURIComponent(market.id)}`}>{formatUtc(market.start_time)}</Link>
                          <span className="subtext">{market.symbol}</span>
                        </div>
                      ) : null}
                    </td>
                    <td>{index === 0 ? <span className={`status-pill ${statusClass(market.status)}`}>{market.status}</span> : null}</td>
                    <td>{label?.source || "-"}</td>
                    <td>{formatPrice(label?.open_price)}</td>
                    <td>{formatPrice(label?.close_price)}</td>
                    <td className={directionClass(label?.direction)}>{formatPct(label?.return_pct)}</td>
                    <td>{label?.sample_count || "-"}</td>
                    <td>{label ? <span className={`status-pill ${statusClass(label.quality)}`}>{label.quality}</span> : "-"}</td>
                  </tr>
                ));
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MarketDailyCounts({ dailyMarketCounts }) {
  const rows = dailyMarketCounts || [];

  return (
    <section className="panel stats-panel daily-market-panel">
      <div className="panel-heading">
        <div>
          <p className="panel-label">Coverage</p>
          <h2>Markets by UTC day</h2>
        </div>
        <span className="status-pill status-muted">since Jun 27, 2026</span>
      </div>
      {rows.length === 0 ? (
        <p className="muted">No markets counted since Jun 27, 2026.</p>
      ) : (
        <div className="daily-market-list">
          {rows.map((day) => {
            const href = `/markets?day=${encodeURIComponent(day.market_day)}`;
            return (
              <div className="daily-market-row" key={day.market_day}>
                <div>
                  <Link className="daily-market-date-link" href={href}>{formatUtcDate(day.market_day)}</Link>
                  <span>
                    {day.closed_count} closed, {day.open_count} open, {day.incomplete_count} incomplete
                  </span>
                </div>
                <Link className="daily-market-count" href={href} aria-label={`View markets for ${day.market_day}`}>
                  <b>{day.markets_total}</b>
                  <span>markets</span>
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ErrorList({ errors }) {
  return (
    <section className="panel error-panel">
      <div className="panel-heading">
        <div>
          <p className="panel-label">Errors</p>
          <h2>Recent collection errors</h2>
        </div>
      </div>
      {errors.length === 0 ? (
        <p className="muted">No recent errors.</p>
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

function DirectionStats({ directionStats }) {
  const rows = directionStats.length > 0 ? directionStats : [];

  return (
    <section className="panel stats-panel">
      <div>
        <p className="panel-label">Labels</p>
        <h2>24h direction count</h2>
      </div>
      {rows.length === 0 ? (
        <p className="muted">No labels yet.</p>
      ) : (
        <div className="direction-grid">
          {rows.map((row) => (
            <div className="direction-stat" key={`${row.source}-${row.direction}`}>
              <span>{row.source}</span>
              <strong className={directionClass(row.direction)}>{row.direction}</strong>
              <b>{row.count}</b>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default async function Home() {
  const data = await getDashboardData();

  if (!data.ok) {
    return <SetupState configured={data.configured} error={data.error} />;
  }

  const stats = data.stats || {};

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">BTCUSDT 5 minute collector</p>
          <h1>Market collection console</h1>
        </div>
        <div className="header-time">{formatUtc(new Date())}</div>
      </header>

      <Heartbeat heartbeat={data.heartbeat} />

      <section className="metrics-grid">
        <Metric label="24h markets" value={stats.markets_total ?? 0} />
        <Metric label="Closed" value={stats.markets_closed ?? 0} tone="good" />
        <Metric label="Open" value={stats.markets_open ?? 0} tone="warn" />
        <Metric label="Incomplete" value={stats.markets_incomplete ?? 0} tone="bad" />
      </section>

      <SourceTiles latestSamples={data.latestSamples} sourceStats={data.sourceStats} />

      <div className="content-grid">
        <MarketRows markets={data.recentMarkets} />
        <div className="side-stack">
          <MarketDailyCounts dailyMarketCounts={data.dailyMarketCounts} />
          <DirectionStats directionStats={data.directionStats} />
          <ErrorList errors={data.recentErrors} />
        </div>
      </div>
    </main>
  );
}
