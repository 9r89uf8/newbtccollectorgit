"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

const MAX_POINTS = 720;
const CHART_WIDTH = 920;
const CHART_HEIGHT = 240;
const CHART_PAD = 34;

function readNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatUtc(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date) + " UTC";
}

function formatPrice(value) {
  const number = readNumber(value);
  if (number === null) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(number);
}

function formatCompactUsd(value) {
  const number = readNumber(value);
  if (number === null) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(number);
}

function formatNumber(value, digits = 2) {
  const number = readNumber(value);
  if (number === null) return "-";
  return number.toFixed(digits);
}

function formatPercent(value, digits = 1) {
  const number = readNumber(value);
  if (number === null) return "-";
  return `${(number * 100).toFixed(digits)}%`;
}

function formatBps(value) {
  const number = readNumber(value);
  if (number === null) return "-";
  return `${number.toFixed(2)} bps`;
}

function formatAge(value) {
  const number = readNumber(value);
  if (number === null) return "-";
  if (number < 1000) return `${Math.round(number)} ms`;
  return `${(number / 1000).toFixed(1)}s`;
}

function signedClass(value) {
  const number = readNumber(value);
  if (number > 0) return "number-positive";
  if (number < 0) return "number-negative";
  return "direction-flat";
}

function statusClass(status) {
  if (status === "complete" || status === "open" || status === "connected") return "status-good";
  if (status === "partial" || status === "stale" || status === "reconnecting") return "status-warn";
  if (status === "missing" || status === "error" || status === "disconnected") return "status-bad";
  return "status-muted";
}

function marketLink(snapshot) {
  return snapshot?.market?.id ? `/markets/${encodeURIComponent(snapshot.market.id)}` : "/markets";
}

function micropriceLean(snapshot) {
  const mid = readNumber(snapshot?.binance?.mid);
  const microprice = readNumber(snapshot?.binance?.microprice);
  const spreadBps = readNumber(snapshot?.binance?.spreadBps);
  if (mid === null || microprice === null || spreadBps === null || mid <= 0 || spreadBps === 0) return null;
  return (2 * (((microprice - mid) / mid) * 10000)) / spreadBps;
}

function snapshotPoint(snapshot) {
  const time = Date.parse(snapshot?.collector?.snapshotTs);
  if (!Number.isFinite(time)) return null;
  return {
    time,
    marketId: snapshot.market?.id || "unknown",
    binanceMid: readNumber(snapshot.binance?.mid),
    chainlinkPrice: readNumber(snapshot.chainlink?.price),
    normalizedUp: readNumber(snapshot.polymarket?.normalizedUp),
    normalizedDown: readNumber(snapshot.polymarket?.normalizedDown),
    cvd: readNumber(snapshot.flow?.cvdMarketQuote),
    netTaker: readNumber(snapshot.flow?.netTakerQuote1s),
    rollingImbalance: readNumber(snapshot.flow?.rollingImbalance30s),
    liquidationNet: readNumber(snapshot.liquidations?.netQuote1s),
    micropriceLean: micropriceLean(snapshot),
  };
}

function addPoint(points, snapshot) {
  const point = snapshotPoint(snapshot);
  if (!point) return points;
  const last = points[points.length - 1];
  const sameMarket = last?.marketId === point.marketId;
  const next = sameMarket ? points.slice() : [];
  if (next[next.length - 1]?.time === point.time) {
    next[next.length - 1] = point;
  } else {
    next.push(point);
  }
  return next.slice(-MAX_POINTS);
}

function Metric({ label, value, tone = "default" }) {
  return (
    <div className={`metric metric-${tone}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value detail-metric-value">{value}</div>
    </div>
  );
}

function DataCard({ label, title, status, children }) {
  return (
    <section className="panel live-card">
      <div className="panel-heading">
        <div>
          <p className="panel-label">{label}</p>
          <h2>{title}</h2>
        </div>
        <span className={`status-pill ${statusClass(status)}`}>{status || "waiting"}</span>
      </div>
      <div className="live-card-body">{children}</div>
    </section>
  );
}

function FieldGrid({ rows }) {
  return (
    <div className="live-field-grid">
      {rows.map((row) => (
        <div key={row.label}>
          <span>{row.label}</span>
          <strong className={row.className || ""}>{row.value}</strong>
        </div>
      ))}
    </div>
  );
}

function chartBounds(points, keys, fixedMin, fixedMax) {
  if (fixedMin !== undefined && fixedMax !== undefined) return { min: fixedMin, max: fixedMax };
  const values = [];
  for (const point of points) {
    for (const key of keys) {
      const value = readNumber(point[key]);
      if (value !== null) values.push(value);
    }
  }
  if (values.length === 0) return { min: 0, max: 1 };
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    const pad = Math.abs(min || 1) * 0.001;
    min -= pad;
    max += pad;
  } else {
    const pad = (max - min) * 0.08;
    min -= pad;
    max += pad;
  }
  return { min, max };
}

function xForTime(time, start, end) {
  if (end <= start) return CHART_PAD;
  return CHART_PAD + ((time - start) / (end - start)) * (CHART_WIDTH - CHART_PAD * 2);
}

function yForValue(value, min, max) {
  if (max <= min) return CHART_HEIGHT / 2;
  return CHART_HEIGHT - CHART_PAD - ((value - min) / (max - min)) * (CHART_HEIGHT - CHART_PAD * 2);
}

function linePath(points, key, start, end, min, max) {
  const parts = [];
  for (const point of points) {
    const value = readNumber(point[key]);
    if (value === null) continue;
    const x = xForTime(point.time, start, end);
    const y = yForValue(value, min, max);
    parts.push(`${parts.length === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return parts.join(" ");
}

function LineChart({ points, series, min, max }) {
  const validPoints = points.filter((point) => series.some((item) => readNumber(point[item.key]) !== null));
  const start = validPoints[0]?.time || Date.now() - 60_000;
  const end = validPoints[validPoints.length - 1]?.time || Date.now();
  const bounds = chartBounds(validPoints, series.map((item) => item.key), min, max);
  const zeroY = bounds.min < 0 && bounds.max > 0 ? yForValue(0, bounds.min, bounds.max) : null;

  if (validPoints.length === 0) {
    return <div className="live-empty-chart">Waiting for live samples.</div>;
  }

  return (
    <div className="live-chart-frame">
      <svg className="live-chart-svg" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="img">
        <rect x="0" y="0" width={CHART_WIDTH} height={CHART_HEIGHT} className="chart-bg" />
        {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
          const y = CHART_PAD + tick * (CHART_HEIGHT - CHART_PAD * 2);
          return <line key={tick} x1={CHART_PAD} x2={CHART_WIDTH - CHART_PAD} y1={y} y2={y} className="chart-grid-line" />;
        })}
        {zeroY !== null ? <line x1={CHART_PAD} x2={CHART_WIDTH - CHART_PAD} y1={zeroY} y2={zeroY} className="chart-zero-line" /> : null}
        {series.map((item) => {
          const path = linePath(validPoints, item.key, start, end, bounds.min, bounds.max);
          return path ? <path key={item.key} d={path} fill="none" stroke={item.color} strokeWidth="2.3" /> : null;
        })}
        <text x={CHART_PAD} y={CHART_HEIGHT - 9} className="chart-axis-label">{formatUtc(start)}</text>
        <text x={CHART_WIDTH - CHART_PAD} y={CHART_HEIGHT - 9} className="chart-axis-label chart-axis-label-right">{formatUtc(end)}</text>
        <text x={CHART_PAD} y="20" className="chart-axis-label">{formatNumber(bounds.max, 2)}</text>
        <text x={CHART_PAD} y={CHART_HEIGHT - CHART_PAD + 14} className="chart-axis-label">{formatNumber(bounds.min, 2)}</text>
      </svg>
      <div className="live-chart-legend">
        {series.map((item) => (
          <span key={item.key}><b style={{ backgroundColor: item.color }} />{item.label}</span>
        ))}
      </div>
    </div>
  );
}

function SourceStrip({ snapshot, connection }) {
  const staleSources = snapshot?.collector?.staleSources || [];
  return (
    <section className="panel live-source-strip">
      <span className={`status-pill ${statusClass(connection)}`}>{connection}</span>
      <span>snapshot {formatUtc(snapshot?.collector?.snapshotTs)}</span>
      <span>lag {formatAge(snapshot?.collector?.eventLoopLagMs)}</span>
      <span>reconnects {snapshot?.collector?.reconnectCount ?? 0}</span>
      <span>stale {staleSources.length ? staleSources.join(", ") : "none"}</span>
    </section>
  );
}

export default function LiveDashboard() {
  const [snapshot, setSnapshot] = useState(null);
  const [points, setPoints] = useState([]);
  const [connection, setConnection] = useState("connecting");
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    function applySnapshot(nextSnapshot) {
      if (!nextSnapshot || nextSnapshot.ok === false) {
        setError(nextSnapshot?.error || "live snapshot unavailable");
        return;
      }
      setSnapshot(nextSnapshot);
      setPoints((current) => addPoint(current, nextSnapshot));
      setError(null);
    }

    fetch("/api/live/snapshot", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) applySnapshot(data);
      })
      .catch((fetchError) => {
        if (!cancelled) setError(fetchError.message || String(fetchError));
      });

    const events = new EventSource("/api/live/events");
    const handleMessage = (event) => {
      try {
        applySnapshot(JSON.parse(event.data));
        setConnection("connected");
      } catch (parseError) {
        setConnection("error");
        setError(parseError.message || String(parseError));
      }
    };

    events.addEventListener("snapshot", handleMessage);
    events.onmessage = handleMessage;
    events.onopen = () => setConnection("connected");
    events.onerror = () => setConnection("reconnecting");

    return () => {
      cancelled = true;
      events.close();
    };
  }, []);

  const latestPoint = points[points.length - 1];
  const priceMove = useMemo(() => {
    const first = points.find((point) => point.binanceMid !== null)?.binanceMid;
    const last = latestPoint?.binanceMid;
    if (first === null || first === undefined || last === null || last === undefined || first <= 0) return null;
    return ((last - first) / first) * 10000;
  }, [points, latestPoint]);

  if (!snapshot) {
    return (
      <section className="setup-state live-waiting">
        <div>
          <p className="eyebrow">Live feed</p>
          <h1>Waiting for collector</h1>
          <p className="setup-copy">{error || "Connecting to the local live collector stream."}</p>
        </div>
      </section>
    );
  }

  const market = snapshot.market || {};
  const binance = snapshot.binance || {};
  const polymarket = snapshot.polymarket || {};
  const chainlink = snapshot.chainlink || {};
  const flow = snapshot.flow || {};
  const liquidations = snapshot.liquidations || {};
  const lean = micropriceLean(snapshot);

  return (
    <>
      <SourceStrip snapshot={snapshot} connection={connection} />
      {error ? <p className="error-text live-error-text">{error}</p> : null}

      <section className="metrics-grid detail-metrics-grid live-metrics-grid">
        <Metric label="Seconds left" value={market.secondsRemaining ?? "-"} tone={market.status === "open" ? "good" : "warn"} />
        <Metric label="Futures mid" value={formatPrice(binance.mid)} />
        <Metric label="Up probability" value={formatPercent(polymarket.normalizedUp)} tone="warn" />
        <Metric label="CVD market" value={formatCompactUsd(flow.cvdMarketQuote)} tone={readNumber(flow.cvdMarketQuote) >= 0 ? "good" : "bad"} />
      </section>

      <section className="panel live-market-panel">
        <div>
          <p className="panel-label">Current market</p>
          <h2>{formatUtc(market.startTime)} to {formatUtc(market.endTime)}</h2>
          <p className="detail-market-id">{market.id}</p>
        </div>
        <div className="heartbeat-meta">
          <Link className="download-link" href={marketLink(snapshot)}>Market detail</Link>
          <span className={`status-pill ${statusClass(market.status)}`}>{market.status}</span>
          <span>{market.slug}</span>
        </div>
      </section>

      <div className="live-grid">
        <DataCard label="Polymarket" title="Up and Down orderbook" status={polymarket.quality}>
          <FieldGrid rows={[
            { label: "Up bid", value: formatPercent(polymarket.up?.bid) },
            { label: "Up ask", value: formatPercent(polymarket.up?.ask) },
            { label: "Up mid", value: formatPercent(polymarket.up?.mid) },
            { label: "Up age", value: formatAge(polymarket.up?.ageMs) },
            { label: "Down bid", value: formatPercent(polymarket.down?.bid) },
            { label: "Down ask", value: formatPercent(polymarket.down?.ask) },
            { label: "Norm up", value: formatPercent(polymarket.normalizedUp) },
            { label: "Raw sum", value: formatNumber(polymarket.probabilitySum, 3) },
          ]} />
        </DataCard>

        <DataCard label="Chainlink" title="Polymarket BTC reference" status={chainlink.quality}>
          <FieldGrid rows={[
            { label: "BTC/USD", value: formatPrice(chainlink.price) },
            { label: "Age", value: formatAge(chainlink.ageMs) },
            { label: "Exchange ts", value: formatUtc(chainlink.exchangeTs) },
            { label: "Received", value: formatUtc(chainlink.receivedTs) },
          ]} />
        </DataCard>

        <DataCard label="Binance Futures" title="Top of book and mark" status={binance.quality}>
          <FieldGrid rows={[
            { label: "Bid", value: formatPrice(binance.bestBid) },
            { label: "Ask", value: formatPrice(binance.bestAsk) },
            { label: "Spread", value: formatBps(binance.spreadBps) },
            { label: "Book age", value: formatAge(binance.bookAgeMs) },
            { label: "Mark", value: formatPrice(binance.markPrice) },
            { label: "Index", value: formatPrice(binance.indexPrice) },
            { label: "Funding", value: formatNumber(binance.fundingRate, 6) },
            { label: "Lean", value: formatNumber(lean, 3), className: signedClass(lean) },
          ]} />
        </DataCard>

        <DataCard label="Flow" title="Live taker flow" status={connection}>
          <FieldGrid rows={[
            { label: "Net 1s", value: formatCompactUsd(flow.netTakerQuote1s), className: signedClass(flow.netTakerQuote1s) },
            { label: "Gross 1s", value: formatCompactUsd(flow.grossTakerQuote1s) },
            { label: "Trades 1s", value: flow.tradeCount1s ?? 0 },
            { label: "30s imbalance", value: formatNumber(flow.rollingImbalance30s, 3), className: signedClass(flow.rollingImbalance30s) },
            { label: "Market buy", value: formatCompactUsd(flow.marketTakerBuyQuote) },
            { label: "Market sell", value: formatCompactUsd(flow.marketTakerSellQuote) },
            { label: "Market CVD", value: formatCompactUsd(flow.cvdMarketQuote), className: signedClass(flow.cvdMarketQuote) },
            { label: "Move", value: formatBps(priceMove), className: signedClass(priceMove) },
          ]} />
        </DataCard>

        <DataCard label="Liquidations" title="Force order snapshots" status={connection}>
          <FieldGrid rows={[
            { label: "Net 1s", value: formatCompactUsd(liquidations.netQuote1s), className: signedClass(liquidations.netQuote1s) },
            { label: "Count 1s", value: liquidations.count1s ?? 0 },
            { label: "Market net", value: formatCompactUsd(liquidations.marketNetQuote), className: signedClass(liquidations.marketNetQuote) },
            { label: "Market count", value: liquidations.marketCount ?? 0 },
          ]} />
        </DataCard>
      </div>

      <section className="panel chart-panel detail-wide-panel live-chart-panel">
        <div className="panel-heading">
          <div>
            <p className="panel-label">Live price</p>
            <h2>Futures mid and Chainlink BTC</h2>
          </div>
          <span className="status-pill status-muted">{points.length} points</span>
        </div>
        <LineChart
          points={points}
          series={[
            { key: "binanceMid", label: "Futures mid", color: "#175cd3" },
            { key: "chainlinkPrice", label: "Chainlink", color: "#067647" },
          ]}
        />
      </section>

      <section className="panel chart-panel detail-wide-panel live-chart-panel">
        <div className="panel-heading">
          <div>
            <p className="panel-label">Live Polymarket</p>
            <h2>Normalized Up and Down</h2>
          </div>
        </div>
        <LineChart
          points={points}
          min={0}
          max={1}
          series={[
            { key: "normalizedUp", label: "Up", color: "#067647" },
            { key: "normalizedDown", label: "Down", color: "#b42318" },
          ]}
        />
      </section>

      <section className="panel chart-panel detail-wide-panel live-chart-panel">
        <div className="panel-heading">
          <div>
            <p className="panel-label">Live pressure</p>
            <h2>Rolling imbalance and microprice lean</h2>
          </div>
        </div>
        <LineChart
          points={points}
          min={-1}
          max={1}
          series={[
            { key: "rollingImbalance", label: "Taker 30s", color: "#175cd3" },
            { key: "micropriceLean", label: "Micro lean", color: "#b54708" },
          ]}
        />
      </section>
    </>
  );
}
