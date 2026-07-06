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

function stripMeridiem(value) {
  const compact = String(value || "").replace(/\s+/g, "");
  const match = compact.match(/^(.*?)(AM|PM)$/i);
  return match ? { time: match[1], meridiem: match[2].toUpperCase() } : { time: compact, meridiem: "" };
}

function formatMarketWindowEt(startValue, endValue) {
  if (!startValue || !endValue) return "-";
  const start = new Date(startValue);
  const end = new Date(endValue);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return "-";

  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
  }).format(start);
  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const startParts = stripMeridiem(timeFormatter.format(start));
  const endParts = stripMeridiem(timeFormatter.format(end));
  const sameMeridiem = startParts.meridiem && startParts.meridiem === endParts.meridiem;
  const range = sameMeridiem
    ? `${startParts.time}-${endParts.time}${endParts.meridiem}`
    : `${startParts.time}${startParts.meridiem}-${endParts.time}${endParts.meridiem}`;

  return `${date}, ${range} ET`;
}

function countdownParts(secondsRemaining) {
  const seconds = Math.max(0, Math.floor(readNumber(secondsRemaining) ?? 0));
  return {
    minutes: String(Math.floor(seconds / 60)).padStart(2, "0"),
    seconds: String(seconds % 60).padStart(2, "0"),
  };
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

function formatSignedDollarDifference(value) {
  const number = readNumber(value);
  if (number === null) return "-";
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Math.abs(number));
  return `${number >= 0 ? "+" : "-"}${formatted}`;
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

function formatSignedCompactUsd(value) {
  const number = readNumber(value);
  if (number === null) return "-";
  if (number === 0) return formatCompactUsd(0);
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(Math.abs(number));
  return `${number > 0 ? "+" : "-"}${formatted}`;
}

function formatNumber(value, digits = 2) {
  const number = readNumber(value);
  if (number === null) return "-";
  return number.toFixed(digits);
}

function formatSignedNumber(value, digits = 1) {
  const number = readNumber(value);
  if (number === null) return "-";
  if (number === 0) return number.toFixed(digits);
  return `${number > 0 ? "+" : ""}${number.toFixed(digits)}`;
}

function formatPercent(value, digits = 1) {
  const number = readNumber(value);
  if (number === null) return "-";
  return `${(number * 100).toFixed(digits)}%`;
}

function formatPercentValue(value, digits = 3) {
  const number = readNumber(value);
  if (number === null) return "-";
  return `${number.toFixed(digits)}%`;
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

function bookImbalance(snapshot) {
  const reportedImbalance = readNumber(snapshot?.binance?.bookImbalance);
  if (reportedImbalance !== null) return reportedImbalance;
  const bestBidQty = readNumber(snapshot?.binance?.bestBidQty);
  const bestAskQty = readNumber(snapshot?.binance?.bestAskQty);
  if (bestBidQty === null || bestAskQty === null) return null;
  const depth = bestBidQty + bestAskQty;
  return depth > 0 ? (bestBidQty - bestAskQty) / depth : null;
}
function micropriceLean(snapshot) {
  const reportedLean = readNumber(snapshot?.binance?.micropriceLean);
  if (reportedLean !== null) return reportedLean;
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
    priceToBeat: readNumber(snapshot.polymarket?.priceToBeat),
    normalizedUp: readNumber(snapshot.polymarket?.normalizedUp),
    normalizedDown: readNumber(snapshot.polymarket?.normalizedDown),
    cvd: readNumber(snapshot.flow?.cvdMarketQuote),
    netTaker: readNumber(snapshot.flow?.netTakerQuote1s),
    rollingCvd30s: readNumber(snapshot.flow?.rollingNet30s),
    rollingImbalance: readNumber(snapshot.flow?.rollingImbalance30s),
    liquidationNet: readNumber(snapshot.liquidations?.netQuote1s),
    micropriceLean: micropriceLean(snapshot),
    bookImbalance: bookImbalance(snapshot),
    micropressure: readNumber(snapshot.binance?.micropricePressureMarket),
    openInterestQuote: readNumber(snapshot.position?.openInterestQuote),
    openInterestChangeQuote: readNumber(snapshot.position?.openInterestChangeQuote),
    openInterestChangePct: readNumber(snapshot.position?.openInterestChangePct),
  };
}

function addPoint(points, snapshot) {
  const point = snapshotPoint(snapshot);
  if (!point) return points;
  const last = points[points.length - 1];
  const sameMarket = last?.marketId === point.marketId;
  const previousPoint = sameMarket ? last : null;
  if (point.micropressure === null && point.micropriceLean !== null) {
    const previousPressure = readNumber(previousPoint?.micropressure) ?? 0;
    const elapsedSeconds = previousPoint?.time ? Math.max(0, Math.min(5, (point.time - previousPoint.time) / 1000)) : 0;
    point.micropressure = previousPressure + point.micropriceLean * elapsedSeconds;
  }
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

function axisTicks(bounds, count = 5) {
  if (!bounds || count <= 1) return [];
  const step = (bounds.max - bounds.min) / (count - 1);
  return Array.from({ length: count }, (_, index) => bounds.max - step * index);
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

function LineChart({
  points,
  series,
  min,
  max,
  rightMin,
  rightMax,
  leftTickCount = 0,
  leftFormatter = formatNumber,
  rightFormatter = formatNumber,
}) {
  const validPoints = points.filter((point) => series.some((item) => readNumber(point[item.key]) !== null));
  const leftSeries = series.filter((item) => item.axis !== "right");
  const rightSeries = series.filter((item) => item.axis === "right");
  const start = validPoints[0]?.time || Date.now() - 60_000;
  const end = validPoints[validPoints.length - 1]?.time || Date.now();
  const leftBounds = chartBounds(validPoints, leftSeries.map((item) => item.key), min, max);
  const rightBounds = rightSeries.length > 0
    ? chartBounds(validPoints, rightSeries.map((item) => item.key), rightMin, rightMax)
    : null;
  const leftZeroY = leftBounds.min < 0 && leftBounds.max > 0 ? yForValue(0, leftBounds.min, leftBounds.max) : null;
  const leftAxisTicks = leftTickCount > 1 ? axisTicks(leftBounds, leftTickCount) : [];
  const rightAxisTicks = rightBounds ? axisTicks(rightBounds, 5) : [];

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
        {leftZeroY !== null ? <line x1={CHART_PAD} x2={CHART_WIDTH - CHART_PAD} y1={leftZeroY} y2={leftZeroY} className="chart-zero-line" /> : null}
        {series.map((item) => {
          const bounds = item.axis === "right" && rightBounds ? rightBounds : leftBounds;
          const path = linePath(validPoints, item.key, start, end, bounds.min, bounds.max);
          return path ? (
            <path
              key={item.key}
              d={path}
              fill="none"
              stroke={item.color}
              strokeWidth={item.strokeWidth || "2.3"}
              strokeDasharray={item.strokeDasharray || undefined}
              strokeLinecap="round"
              opacity={item.opacity || 1}
            />
          ) : null;
        })}
        <text x={CHART_PAD} y={CHART_HEIGHT - 9} className="chart-axis-label">{formatUtc(start)}</text>
        <text x={CHART_WIDTH - CHART_PAD} y={CHART_HEIGHT - 9} className="chart-axis-label chart-axis-label-right">{formatUtc(end)}</text>
        {leftAxisTicks.length > 0 ? (
          <g className="chart-axis-left-scale">
            {leftAxisTicks.map((value, index) => {
              const y = yForValue(value, leftBounds.min, leftBounds.max);
              const labelY = Math.min(CHART_HEIGHT - CHART_PAD + 14, Math.max(20, y + 4));
              return (
                <g key={`${index}-${value}`}>
                  <line x1="4" x2={CHART_PAD} y1={y} y2={y} className="chart-axis-left-tick" />
                  <text x="6" y={labelY} className="chart-axis-label chart-axis-label-left-strong">{leftFormatter(value)}</text>
                </g>
              );
            })}
          </g>
        ) : (
          <>
            <text x={CHART_PAD} y="20" className="chart-axis-label">{leftFormatter(leftBounds.max)}</text>
            <text x={CHART_PAD} y={CHART_HEIGHT - CHART_PAD + 14} className="chart-axis-label">{leftFormatter(leftBounds.min)}</text>
          </>
        )}
        {rightBounds ? (
          <g className="chart-axis-right-scale">
            {rightAxisTicks.map((value, index) => {
              const y = yForValue(value, rightBounds.min, rightBounds.max);
              const labelY = Math.min(CHART_HEIGHT - CHART_PAD + 14, Math.max(20, y + 4));
              return (
                <g key={`${index}-${value}`}>
                  <line x1={CHART_WIDTH - CHART_PAD} x2={CHART_WIDTH - 4} y1={y} y2={y} className="chart-axis-right-tick" />
                  <text x={CHART_WIDTH - 6} y={labelY} className="chart-axis-label chart-axis-label-right chart-axis-label-right-strong">{rightFormatter(value)}</text>
                </g>
              );
            })}
          </g>
        ) : null}
      </svg>
      <div className="live-chart-legend">
        {series.map((item) => (
          <span key={item.key}><b style={{ backgroundColor: item.color }} />{item.label}{item.axis === "right" ? " (right)" : ""}</span>
        ))}
      </div>
    </div>
  );
}

function MarketTicket({ snapshot, market, priceToBeat, currentPrice, difference }) {
  const diff = readNumber(difference);
  const direction = diff === null ? "" : diff >= 0 ? "Up" : "Down";
  const directionClass = diff === null ? "direction-flat" : diff >= 0 ? "number-positive" : "number-negative";
  const differenceText = diff === null ? "-" : `${formatSignedDollarDifference(diff)} ${direction}`;
  const countdown = countdownParts(market.secondsRemaining);

  return (
    <section className="live-ticket" aria-label="Current BTC market">
      <div className="live-ticket-main">
        <div className="live-ticket-title-row">
          <div className="live-btc-icon" aria-hidden="true">&#8383;</div>
          <div className="live-ticket-title-copy">
            <h1>BTC Up or Down 5m</h1>
            <p>{formatMarketWindowEt(market.startTime, market.endTime)}</p>
          </div>
        </div>

        <div className="live-ticket-price-row">
          <div className="live-ticket-price live-ticket-beat">
            <span>Price To Beat</span>
            <strong>{formatPrice(priceToBeat)}</strong>
          </div>
          <div className="live-ticket-divider" aria-hidden="true" />
          <div className="live-ticket-price live-ticket-current">
            <span>Current Price</span>
            <strong>{formatPrice(currentPrice)}</strong>
          </div>
          <div className="live-ticket-price live-ticket-diff">
            <span>Difference</span>
            <strong className={directionClass}>{differenceText}</strong>
          </div>
        </div>
      </div>

      <div className="live-ticket-side">
        <div className="live-ticket-actions">
          <Link href={marketLink(snapshot)} aria-label="Open market detail">&lt;/&gt;</Link>
          <Link href={marketLink(snapshot)} aria-label="Copy market link">#</Link>
          <Link href={marketLink(snapshot)} aria-label="Bookmark market">[]</Link>
        </div>
        <div className="live-ticket-countdown" aria-label={`${countdown.minutes} minutes ${countdown.seconds} seconds remaining`}>
          <div><strong>{countdown.minutes}</strong><span>MINS</span></div>
          <div><strong>{countdown.seconds}</strong><span>SECS</span></div>
        </div>
      </div>
    </section>
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
  const position = snapshot.position || {};
  const flow = snapshot.flow || {};
  const liquidations = snapshot.liquidations || {};
  const book = bookImbalance(snapshot);
  const micropressure = readNumber(binance.micropricePressureMarket) ?? readNumber(latestPoint?.micropressure);
  const priceToBeat = readNumber(polymarket.priceToBeat);
  const currentBtcPrice = readNumber(chainlink.price) ?? readNumber(binance.mid);
  const priceDifference = priceToBeat !== null && currentBtcPrice !== null ? currentBtcPrice - priceToBeat : null;

  return (
    <>
      <MarketTicket
        snapshot={snapshot}
        market={market}
        priceToBeat={priceToBeat}
        currentPrice={currentBtcPrice}
        difference={priceDifference}
      />
      <section className="panel chart-panel detail-wide-panel live-chart-panel">
        <div className="panel-heading">
          <div>
            <p className="panel-label">Live price</p>
            <h2>Futures mid, Chainlink, and price to beat</h2>
          </div>
          <div className="live-probability-pills">
            <span className="status-pill status-muted">{points.length} points</span>
          </div>
        </div>
        <LineChart
          points={points}
          series={[
            { key: "binanceMid", label: "Futures mid", color: "#175cd3" },
            { key: "chainlinkPrice", label: "Chainlink", color: "#067647" },
            { key: "priceToBeat", label: "Price to beat", color: "#b54708" },
          ]}
        />
      </section>

      <section className="panel chart-panel detail-wide-panel live-chart-panel">
        <div className="panel-heading">
          <div>
            <p className="panel-label">Live Polymarket</p>
            <h2>Normalized Up and Down</h2>
          </div>
          <div className="live-probability-pills">
            <span className="status-pill status-good">Up {formatPercent(polymarket.normalizedUp)}</span>
            <span className="status-pill status-bad">Down {formatPercent(polymarket.normalizedDown)}</span>
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
            <h2>Rolling imbalance and book imbalance</h2>
          </div>
        </div>
        <LineChart
          points={points}
          min={-1}
          max={1}
          series={[
            { key: "rollingImbalance", label: "Taker 30s", color: "#175cd3" },
            { key: "bookImbalance", label: "Book imbalance", color: "#067647", strokeWidth: "2.6" },
          ]}
        />
      </section>

      <section className="panel chart-panel detail-wide-panel live-chart-panel">
        <div className="panel-heading">
          <div>
            <p className="panel-label">Live flow pressure</p>
            <h2>30s CVD, market CVD, and micropressure</h2>
          </div>
        </div>
        <LineChart
          points={points}
          leftTickCount={5}
          leftFormatter={formatSignedCompactUsd}
          rightFormatter={formatSignedNumber}
          series={[
            { key: "rollingCvd30s", label: "30s CVD", color: "#175cd3" },
            { key: "cvd", label: "Market CVD", color: "#b54708" },
            { key: "micropressure", label: "Micropressure", color: "#c11574", axis: "right" },
          ]}
        />
      </section>
      <section className="panel chart-panel detail-wide-panel live-chart-panel">
        <div className="panel-heading">
          <div>
            <p className="panel-label">Live positioning</p>
            <h2>Open interest change from market open</h2>
          </div>
          <div className="live-probability-pills">
            <span className={`status-pill ${statusClass(position.quality)}`}>{position.quality || "waiting"}</span>
          </div>
        </div>
        <LineChart
          points={points}
          leftTickCount={5}
          leftFormatter={formatSignedCompactUsd}
          series={[
            { key: "openInterestChangeQuote", label: "OI change", color: "#7a5af8", strokeWidth: "2.6" },
          ]}
        />
      </section>
      <SourceStrip snapshot={snapshot} connection={connection} />
      {error ? <p className="error-text live-error-text">{error}</p> : null}
      <div className="live-grid">
        <DataCard label="Polymarket" title="Live normalized percentages" status={polymarket.quality}>
          <FieldGrid rows={[
            { label: "Live Up", value: formatPercent(polymarket.normalizedUp), className: "number-positive" },
            { label: "Live Down", value: formatPercent(polymarket.normalizedDown), className: "number-negative" },
            { label: "Price to beat", value: formatPrice(polymarket.priceToBeat) },
            { label: "Up mid", value: formatPercent(polymarket.up?.mid) },
            { label: "Down mid", value: formatPercent(polymarket.down?.mid) },
            { label: "Up bid", value: formatPercent(polymarket.up?.bid) },
            { label: "Up ask", value: formatPercent(polymarket.up?.ask) },
            { label: "Down bid", value: formatPercent(polymarket.down?.bid) },
            { label: "Down ask", value: formatPercent(polymarket.down?.ask) },
            { label: "Raw sum", value: formatNumber(polymarket.probabilitySum, 3) },
            { label: "Data age", value: formatAge(Math.max(readNumber(polymarket.up?.ageMs) ?? 0, readNumber(polymarket.down?.ageMs) ?? 0)) },
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
            { label: "Book imbalance", value: formatNumber(book, 3), className: signedClass(book) },
            { label: "Micropressure", value: formatNumber(micropressure, 2), className: signedClass(micropressure) },
            { label: "Micro samples", value: binance.micropriceSampleCount1s ?? 0 },
          ]} />
        </DataCard>
        <DataCard label="Positioning" title="Open interest" status={position.quality}>
          <FieldGrid rows={[
            { label: "OI notional", value: formatCompactUsd(position.openInterestQuote) },
            { label: "OI BTC", value: formatNumber(position.openInterestBase, 3) },
            { label: "OI change", value: formatSignedCompactUsd(position.openInterestChangeQuote), className: signedClass(position.openInterestChangeQuote) },
            { label: "OI change %", value: formatPercentValue(position.openInterestChangePct), className: signedClass(position.openInterestChangePct) },
            { label: "Open OI", value: formatCompactUsd(position.openInterestOpenQuote) },
            { label: "Mark", value: formatPrice(position.markPrice) },
            { label: "Premium", value: formatBps(position.premiumBps), className: signedClass(position.premiumBps) },
            { label: "Age", value: formatAge(position.ageMs) },
          ]} />
        </DataCard>

        <DataCard label="Flow" title="Live taker flow" status={connection}>
          <FieldGrid rows={[
            { label: "Net 1s", value: formatCompactUsd(flow.netTakerQuote1s), className: signedClass(flow.netTakerQuote1s) },
            { label: "Gross 1s", value: formatCompactUsd(flow.grossTakerQuote1s) },
            { label: "30s CVD", value: formatCompactUsd(flow.rollingNet30s), className: signedClass(flow.rollingNet30s) },
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

    </>
  );
}

