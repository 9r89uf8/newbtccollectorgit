"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";

const FLOW_HELP_TOPIC_IDS = new Set(["netTaker", "cvd", "micropricePressure", "netLiquidation"]);
const MICROPRICE_HELP_TOPIC_IDS = new Set(["microprice"]);
const IMBALANCE_HELP_TOPIC_IDS = new Set(["takerImbalance", "bookImbalance", "spread"]);
const OI_HELP_TOPIC_IDS = new Set(["openInterest", "markIndexBasis", "btcOnOi"]);
const HIDDEN_HELP_TOPIC_IDS = new Set(["bookUpdates"]);

const HELP_TOPICS = [
  {
    id: "price",
    label: "BTC price",
    text: "The Binance Futures BTCUSDT last price sampled during this 5 minute market.",
  },
  {
    id: "wsMid",
    label: "WS mid",
    text: "One-second Binance Futures WebSocket mid price from the best bid and best ask. It fills the gaps between REST price samples.",
  },
  {
    id: "netTaker",
    label: "Net taker",
    text: "Aggressive buy dollars minus aggressive sell dollars. Positive means market buyers hit asks more than market sellers hit bids, which often supports upward pressure. Negative means sellers were more aggressive, which often pressures price down. Tooltips show raw dollars.",
  },
  {
    id: "cvd",
    label: "CVD",
    text: "Cumulative volume delta is the running sum of aggressive buyer dollars minus aggressive seller dollars. Direction matters, but the better read is divergence: did aggressive flow actually move BTC price, or was it absorbed?",
    details: [
      "CVD rising + price rising: buyers are in control because aggressive buying is moving price up.",
      "CVD rising + price flat: sellers are absorbing the aggressive buys, so the buying may be less bullish than it looks.",
      "CVD falling + price flat: buyers are absorbing aggressive sells, which can be a support or reversal clue.",
      "CVD falling + price falling: sellers are in control because aggressive selling is moving price down.",
      "A useful chart read is CVD direction versus price response, not CVD direction alone.",
    ],
  },
  {
    id: "netLiquidation",
    label: "Net liq",
    text: "One-second liquidation notional from the WebSocket force-order stream. Positive means buy liquidation notional exceeded sell liquidation notional; negative means sell liquidations dominated.",
  },
  {
    id: "micropricePressure",
    label: "Micropressure",
    text: "Microprice pressure is the market-reset running sum of one-second microprice lean. Positive means the top-of-book has leaned toward upward pressure over the market; negative means it has leaned toward downward pressure.",
    details: [
      "It is not dollar volume. It accumulates normalized top-of-book lean, so values can extend beyond -1 to +1.",
      "Use it with CVD and net taker flow: flow tells you what executed, while micropressure tells you how the displayed best bid/ask leaned.",
    ],
  },
  {
    id: "takerImbalance",
    label: "Taker imbalance",
    text: "Taker imbalance measures aggressive executed trades: market buys crossing the spread versus market sells crossing the spread.",
    details: [
      "A taker executes immediately: a market buy hits the ask; a market sell hits the bid.",
      "Formula: (market buy volume - market sell volume) / (market buy volume + market sell volume). Range: -1 to +1.",
      "Example: 120 BTC market buys and 80 BTC market sells gives +0.20, meaning buyers were more aggressive during that window.",
      "Positive usually means aggressive buying pressure; negative means aggressive selling pressure.",
      "The purple chart line uses trailing 30-second net taker quote divided by trailing 30-second gross taker quote, with a volume floor to damp tiny +1/-1 buckets.",
      "Read it with book imbalance and price response. Strong taker pressure with little price movement can mean passive liquidity is absorbing the flow.",
    ],
  },
  {
    id: "microprice",
    label: "Microprice",
    text: "Microprice is the order book's center of gravity: (best ask * bid size + best bid * ask size) / (bid size + ask size). If bid size is heavier, microprice leans above the midprice toward the ask, which points to short-term upward pressure. If ask size is heavier, it leans below the midprice toward the bid, which points to short-term downward pressure.",
    details: [
      "The microprice panel displays two causal smoothed lines: EWMA 3s for very short-horizon pressure and avg 10s for short persistence.",
      "Microprice EWMA 3s is an exponentially weighted blend of the current valid second and the prior two seconds, so it reacts quickly without looking ahead.",
      "Microprice 10s is the trailing average normalized lean over the last 10 valid seconds, which reduces noise while keeping the signal responsive.",
      "Both visible lean lines stay on the -1 to +1 scale: above 0 = upward book pressure, below 0 = downward book pressure, near 0 = balanced. The separate pressure line can reach +30 or -70 because it accumulates one-second lean over time.",
    ],
  },
  {
    id: "bookImbalance",
    label: "Book imbalance",
    text: "Book imbalance measures resting liquidity displayed in the order book, comparing bid depth versus ask depth near the current price.",
    details: [
      "Formula: (bid depth - ask depth) / (bid depth + ask depth). Range: -1 to +1.",
      "Example: 500 BTC bid depth and 300 BTC ask depth gives +0.25, meaning more visible buy-side liquidity near price.",
      "Positive often suggests support below price or thinner ask resistance; negative suggests more sell-side liquidity above price or weaker bid support.",
      "Book imbalance is displayed liquidity, not executed flow. Limit orders can be canceled, moved, or spoofed quickly.",
      "Combined read: taker+/book+ is stronger bullish pressure; taker-/book- is stronger bearish pressure; taker+/book- can mean asks absorbing buys; taker-/book+ can mean bids absorbing sells.",
    ],
  },
  {
    id: "spread",
    label: "Spread",
    text: "Best ask minus best bid, measured in basis points. Wider spread often means thinner or less stable liquidity. The spread line in the imbalance panel uses sampled Binance Futures best bid/ask spread.",
  },
  {
    id: "bookUpdates",
    label: "Book updates",
    text: "A top-of-book update is a WebSocket message that the best bid price, best bid quantity, best ask price, or best ask quantity changed. Example: before best bid = 60194.90 qty 3.2 BTC and best ask = 60195.00 qty 1.8 BTC; after best bid = 60194.90 qty 4.1 BTC and best ask = 60195.10 qty 0.9 BTC. That counts as a top-of-book update.",
  },
  {
    id: "openInterest",
    label: "Open interest",
    text: "Total open BTC futures exposure. The chart plots open-interest change from the first sample in the market, so small intramarket moves are visible even when absolute OI is around several billion dollars.",
    details: [
      "The left axis is OI change: +$2M means open interest is about $2M above the market's first OI sample; -$2M means about $2M below it.",
      "The tooltip still shows the absolute open-interest value, plus the change from the first sample.",
      "Rising OI means new leverage is entering; falling OI means positions are closing. Rising OI with price can support continuation, while falling OI during a sharp move often points to squeeze or deleveraging.",
    ],
  },
  {
    id: "markIndexBasis",
    label: "Mark/index",
    text: "Mark price is one price, index price is a different reference price, and mark/index is the gap between them measured in bps.",
    details: [
      "Example: mark_price = 59,726.81 and index_price = 59,751.19.",
      "Then mark/index basis is about -4.08 bps.",
      "Meaning: Binance's mark price was about 4.08 bps below its spot-based BTC index.",
      "Mark price = Binance's calculated fair price for the BTCUSDT perp.",
      "Index price = Binance's spot-based BTC reference price.",
    ],
  },  {
    id: "btcOnOi",
    label: "BTC on OI",
    text: "BTC on OI is the Binance Futures BTC price drawn on the positioning panel as a reference line, so open-interest and mark/index moves can be compared against price direction in the same time window.",
  },
];

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

function formatSignedCompactUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  const formatted = formatCompactUsd(Math.abs(number));
  if (number > 0) return `+${formatted}`;
  if (number < 0) return `-${formatted}`;
  return formatted;
}

function formatOpenInterestUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  const abs = Math.abs(number);
  const sign = number < 0 ? "-$" : "$";
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(4)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  return formatCompactUsd(number);
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

function formatDecimal(value, digits = 3) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${number >= 0 ? "+" : ""}${number.toFixed(digits)}`;
}


function formatProbability(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${(number * 100).toFixed(1)}%`;
}

function formatClassName(value) {
  if (!value) return "-";
  return String(value).replaceAll("_", " ");
}

function formatBps(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)} bps`;
}

function formatCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return new Intl.NumberFormat("en-US").format(number);
}

function formatMilliseconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${number.toFixed(0)} ms`;
}

function formatUtc(value) {
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

function toTimeValue(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const NET_TAKER_LOG_BASE = 10000;
const TAKER_PRESSURE_WINDOW_MS = 30 * 1000;
const TAKER_PRESSURE_MIN_DENOMINATOR_QUOTE = 50_000;

function signedLogNetTaker(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.sign(number) * Math.log10(1 + Math.abs(number) / NET_TAKER_LOG_BASE);
}

function invertSignedLogNetTaker(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.sign(number) * NET_TAKER_LOG_BASE * (10 ** Math.abs(number) - 1);
}

function medianPositive(values) {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function buildTrailingTakerPressureData(bucketRows) {
  const rows = bucketRows
    .map((bucket) => ({
      time: bucket.endTime ?? bucket.time,
      net: finiteNumber(bucket.netTaker) ?? 0,
      gross: Math.max(finiteNumber(bucket.grossTaker) ?? 0, 0),
    }))
    .filter((bucket) => bucket.time !== null)
    .sort((a, b) => a.time - b.time);

  const volumeFloor = Math.max(
    medianPositive(rows.map((bucket) => bucket.gross)) ?? 0,
    TAKER_PRESSURE_MIN_DENOMINATOR_QUOTE
  );
  const data = [];
  let windowStart = 0;
  let rollingNet = 0;
  let rollingGross = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const bucket = rows[index];
    rollingNet += bucket.net;
    rollingGross += bucket.gross;

    const cutoff = bucket.time - TAKER_PRESSURE_WINDOW_MS;
    while (windowStart <= index && rows[windowStart].time <= cutoff) {
      rollingNet -= rows[windowStart].net;
      rollingGross -= rows[windowStart].gross;
      windowStart += 1;
    }

    const denominator = Math.max(rollingGross, volumeFloor);
    const pressure = denominator > 0 ? rollingNet / denominator : null;
    data.push([
      bucket.time,
      pressure === null ? null : Math.max(-1, Math.min(1, pressure)),
      rollingNet,
      rollingGross,
    ]);
  }

  return data;
}

function buildTooltip(params) {
  const rows = Array.isArray(params) ? params : [params];
  const time = rows[0]?.value?.[0];
  const byName = new Map(rows.map((row) => [row.seriesName, row]));

  function marker(item) {
    return `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${item.color};margin-right:6px"></span>`;
  }

  function row(label, seriesName, formatter, valueIndex = 1) {
    const item = byName.get(seriesName);
    if (!item) return "";
    return `<div>${marker(item)}${label}: <b>${formatter(item.value?.[valueIndex])}</b></div>`;
  }

  function detail(label, seriesName, valueIndex, formatter) {
    const item = byName.get(seriesName);
    if (!item) return "";
    const value = item.value?.[valueIndex];
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "";
    return `<div style="padding-left:16px;color:#667085">${label}: <b>${formatter(value)}</b></div>`;
  }

  function detailText(label, seriesName, valueIndex) {
    const item = byName.get(seriesName);
    if (!item) return "";
    const value = item.value?.[valueIndex];
    if (!value || value === "none") return "";
    return `<div style="padding-left:16px;color:#667085">${label}: <b>${formatClassName(value)}</b></div>`;
  }

  return `
    <div style="min-width:260px">
      <div style="font-weight:700;margin-bottom:6px">${formatUtc(time)}</div>
      ${row("BTC price", "BTC price", formatPrice)}
      ${row("WS mid", "WS mid", formatPrice)}
      ${detail("Mid moves", "WS mid", 3, formatCount)}
      ${detail("Microprice dev", "WS mid", 4, formatBps)}
      ${detail("Event lag", "WS mid", 5, formatMilliseconds)}
      ${row("Net taker", "Net taker", formatCompactUsd, 2)}
      ${row("CVD", "CVD", formatCompactUsd, 2)}
      ${row("Pressure sum", "Microprice pressure", (value) => formatDecimal(value, 1))}
      ${detailText("Behavior", "Microprice pressure", 2)}
      ${row("Net liquidation", "Net liquidation", formatCompactUsd, 2)}
      ${row("Taker 30s", "Taker pressure 30s", (value) => formatDecimal(value, 3))}
      ${detail("30s net", "Taker pressure 30s", 2, formatCompactUsd)}
      ${detail("30s gross", "Taker pressure 30s", 3, formatCompactUsd)}
      ${row("Book imbalance", "Book imbalance", (value) => formatDecimal(value, 3))}
      ${row("Microprice EWMA 3s", "Microprice EWMA 3s", (value) => formatDecimal(value, 3))}
      ${row("Microprice 10s", "Microprice 10s", (value) => formatDecimal(value, 3))}
      ${detailText("Micro signal", "Microprice 10s", 2)}
      ${row("Spread", "Spread", formatBps)}
      ${row("Open interest", "Open interest", formatOpenInterestUsd, 2)}
      ${detail("OI change", "Open interest", 1, formatSignedCompactUsd)}
      ${row("Mark/index basis", "Mark/index basis", formatBps)}
      ${row("BTC on OI", "BTC on OI", formatPrice)}
    </div>
  `;
}

export default function MarketMicrostructureChart({
  marketStart,
  marketEnd,
  priceSeries,
  buckets,
  tradeFlow1s = [],
  positionSeries = [],
  webSocketSummaries = [],
  micropriceBuckets = [],
  polymarketProbabilities = [],
}) {
  const chartRef = useRef(null);
  const [activeTopHelpId, setActiveTopHelpId] = useState(null);
  const [activeFlowHelpId, setActiveFlowHelpId] = useState(null);
  const [activeMicropriceHelpId, setActiveMicropriceHelpId] = useState(null);
  const [activeImbalanceHelpId, setActiveImbalanceHelpId] = useState(null);
  const [activeOiHelpId, setActiveOiHelpId] = useState(null);
  const activeTopHelp = HELP_TOPICS.find((topic) => topic.id === activeTopHelpId);
  const activeFlowHelp = HELP_TOPICS.find((topic) => topic.id === activeFlowHelpId);
  const activeMicropriceHelp = HELP_TOPICS.find((topic) => topic.id === activeMicropriceHelpId);
  const activeImbalanceHelp = HELP_TOPICS.find((topic) => topic.id === activeImbalanceHelpId);
  const activeOiHelp = HELP_TOPICS.find((topic) => topic.id === activeOiHelpId);

  const option = useMemo(() => {
    const priceData = priceSeries
      .map((sample) => [toTimeValue(sample.time), finiteNumber(sample.price)])
      .filter(([time, price]) => time !== null && price !== null);
    const bucketRows = buckets
      .map((bucket) => ({
        time: toTimeValue(bucket.bucket_start),
        endTime: toTimeValue(bucket.bucket_end),
        netTaker: finiteNumber(bucket.net_taker_quote),
        grossTaker: finiteNumber(bucket.total_volume_quote),
        cvdMarket: finiteNumber(bucket.cvd_market_quote),
        takerImbalance: finiteNumber(bucket.taker_imbalance),
        bookImbalance: finiteNumber(bucket.book_imbalance_5bps),
        spread: finiteNumber(bucket.spread_bps),
      }))
      .filter((bucket) => bucket.time !== null);
    const tradeFlowRows = tradeFlow1s
      .map((bucket) => ({
        time: toTimeValue(bucket.bucket_start),
        endTime: toTimeValue(bucket.bucket_end),
        netTaker: finiteNumber(bucket.net_taker_quote),
        grossTaker: finiteNumber(bucket.gross_taker_quote),
        cvdMarket: finiteNumber(bucket.cvd_market_quote),
        takerImbalance: finiteNumber(bucket.taker_imbalance),
      }))
      .filter((bucket) => bucket.time !== null);
    const flowRows = tradeFlowRows.length > 0 ? tradeFlowRows : bucketRows;
    const positionRows = positionSeries
      .map((sample) => ({
        time: toTimeValue(sample.time),
        openInterestQuote: finiteNumber(sample.open_interest_quote),
        premiumBps: finiteNumber(sample.premium_bps),
      }))
      .filter((sample) => sample.time !== null);
    const webSocketRows = webSocketSummaries
      .map((summary) => ({
        time: toTimeValue(summary.bucket_start),
        midPrice: finiteNumber(summary.mid_price_close),
        spreadAvg: finiteNumber(summary.spread_bps_avg),
        spreadMax: finiteNumber(summary.spread_bps_max),
        netLiquidation: finiteNumber(summary.liquidation_net_quote),
        bookTickerUpdateCount: finiteNumber(summary.book_ticker_update_count),
        midPriceMoveCount: finiteNumber(summary.mid_price_move_count),
        micropriceBpsFromMid: finiteNumber(summary.microprice_bps_from_mid_close),
        avgEventLagMs: finiteNumber(summary.avg_event_lag_ms),
      }))
      .filter((summary) => summary.time !== null);
    const micropriceRows = micropriceBuckets
      .map((bucket) => ({
        time: toTimeValue(bucket.bucket_start),
        lean: finiteNumber(bucket.microprice_lean),
        leanDelta1s: finiteNumber(bucket.lean_delta_1s),
        ewmaLean3s: finiteNumber(bucket.ewma_lean_3s),
        avgLean5s: finiteNumber(bucket.avg_lean_5s),
        avgLean10s: finiteNumber(bucket.avg_lean_10s),
        avgLean30s: finiteNumber(bucket.avg_lean_30s),
        pressureMarket: finiteNumber(bucket.microprice_pressure_market),
        persistenceSignal: bucket.persistence_signal,
        behavior: bucket.microprice_behavior,
      }))
      .filter((bucket) => bucket.time !== null);
    const polymarketRows = polymarketProbabilities
      .map((sample) => ({
        time: toTimeValue(sample.time),
        upProbability: finiteNumber(sample.up_probability),
        downProbability: finiteNumber(sample.down_probability),
      }))
      .filter((sample) => sample.time !== null);

    const netTakerData = flowRows
      .filter((bucket) => bucket.netTaker !== null)
      .map((bucket) => [bucket.time, signedLogNetTaker(bucket.netTaker), bucket.netTaker]);
    const cvdData = flowRows
      .filter((bucket) => bucket.cvdMarket !== null)
      .map((bucket) => [bucket.time, signedLogNetTaker(bucket.cvdMarket), bucket.cvdMarket]);
    const takerPressure30sData = buildTrailingTakerPressureData(flowRows);
    const bookImbalanceData = bucketRows
      .filter((bucket) => bucket.bookImbalance !== null)
      .map((bucket) => [bucket.time, bucket.bookImbalance]);
    const spreadData = bucketRows
      .filter((bucket) => bucket.spread !== null)
      .map((bucket) => [bucket.time, bucket.spread]);
    const openInterestBase = positionRows.find((sample) => sample.openInterestQuote !== null)?.openInterestQuote ?? null;
    const openInterestData = positionRows
      .filter((sample) => sample.openInterestQuote !== null)
      .map((sample) => [
        sample.time,
        openInterestBase === null ? 0 : sample.openInterestQuote - openInterestBase,
        sample.openInterestQuote,
      ]);
    const premiumData = positionRows
      .filter((sample) => sample.premiumBps !== null)
      .map((sample) => [sample.time, sample.premiumBps]);
    const wsMidData = webSocketRows
      .filter((summary) => summary.midPrice !== null)
      .map((summary) => [
        summary.time,
        summary.midPrice,
        summary.bookTickerUpdateCount,
        summary.midPriceMoveCount,
        summary.micropriceBpsFromMid,
        summary.avgEventLagMs,
      ]);
    const wsSpreadData = webSocketRows
      .filter((summary) => summary.spreadAvg !== null)
      .map((summary) => [summary.time, summary.spreadAvg, summary.spreadMax]);
    const bookUpdateData = webSocketRows
      .filter((summary) => summary.bookTickerUpdateCount !== null)
      .map((summary) => [summary.time, summary.bookTickerUpdateCount]);
    const netLiquidationData = webSocketRows
      .filter((summary) => summary.netLiquidation !== null)
      .map((summary) => [
        summary.time,
        signedLogNetTaker(summary.netLiquidation),
        summary.netLiquidation,
      ]);
    const micropriceEwma3Data = micropriceRows
      .filter((bucket) => bucket.ewmaLean3s !== null)
      .map((bucket) => [bucket.time, bucket.ewmaLean3s]);
    const micropriceAvg10Data = micropriceRows
      .filter((bucket) => bucket.avgLean10s !== null)
      .map((bucket) => [bucket.time, bucket.avgLean10s, bucket.persistenceSignal]);
    const micropricePressureData = micropriceRows
      .filter((bucket) => bucket.pressureMarket !== null)
      .map((bucket) => [bucket.time, bucket.pressureMarket, bucket.behavior]);
    const marketUpData = polymarketRows
      .filter((sample) => sample.upProbability !== null)
      .map((sample) => [sample.time, sample.upProbability]);
    const marketDownData = polymarketRows
      .filter((sample) => sample.downProbability !== null)
      .map((sample) => [sample.time, sample.downProbability]);
    const start = toTimeValue(marketStart);
    const end = toTimeValue(marketEnd);

    return {
      animation: false,
      backgroundColor: "#fbfcfe",
      color: ["#175cd3", "#344054", "#067647", "#c11574", "#7a5af8", "#16b364", "#b54708", "#f79009", "#667085", "#0e7490", "#c11574", "#475467", "#155eef"],
      legend: [
        {
          top: 6,
          left: 10,
          itemWidth: 12,
          itemHeight: 8,
          textStyle: { color: "#475467", fontSize: 12 },
        },
        {
          data: [
            { name: "Net taker", itemStyle: { color: "#067647" } },
            { name: "CVD", itemStyle: { color: "#175cd3" } },
            { name: "Microprice pressure", itemStyle: { color: "#c11574" } },
            { name: "Net liquidation", itemStyle: { color: "#0e7490" } },
          ],
          top: 270,
          left: 170,
          icon: "rect",
          itemWidth: 24,
          itemHeight: 4,
          formatter: (name) => {
            const labels = {
              "Net liquidation": "Net liq",
              "Microprice pressure": "Micropressure",
            };
            return labels[name] || name;
          },
          textStyle: { color: "#475467", fontSize: 12 },
        },
        {
          data: [
            { name: "Microprice EWMA 3s", itemStyle: { color: "#c11574" } },
            { name: "Microprice 10s", itemStyle: { color: "#155eef" } },
          ],
          top: 460,
          left: 170,
          icon: "rect",
          itemWidth: 24,
          itemHeight: 4,
          formatter: (name) => {
            const labels = {
              "Microprice EWMA 3s": "EWMA 3s",
              "Microprice 10s": "avg 10s",
            };
            return labels[name] || name;
          },
          textStyle: { color: "#475467", fontSize: 12 },
        },
        {
          data: [
            { name: "Taker pressure 30s", itemStyle: { color: "#7a5af8" } },
            { name: "Book imbalance", itemStyle: { color: "#067647" } },
            { name: "Spread", itemStyle: { color: "#b54708" } },
          ],
          top: 665,
          left: 170,
          icon: "rect",
          itemWidth: 24,
          itemHeight: 4,
          textStyle: { color: "#475467", fontSize: 12 },
        },
        {
          data: [
            { name: "Open interest", itemStyle: { color: "#0e7490" } },
            { name: "Mark/index basis", itemStyle: { color: "#c11574" } },
            { name: "BTC on OI", itemStyle: { color: "#475467" } },
          ],
          top: 850,
          left: 170,
          icon: "rect",
          itemWidth: 24,
          itemHeight: 4,
          formatter: (name) => {
            const labels = {
              "Open interest": "OI change",
            };
            return labels[name] || name;
          },
          textStyle: { color: "#475467", fontSize: 12 },
        },
      ],
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross", link: [{ xAxisIndex: "all" }] },
        appendToBody: true,
        confine: true,
        formatter: buildTooltip,
      },
      dataZoom: [
        { type: "inside", xAxisIndex: [0, 1, 2, 3, 4], filterMode: "none" },
        {
          type: "slider",
          xAxisIndex: [0, 1, 2, 3, 4],
          filterMode: "none",
          bottom: 10,
          height: 22,
          borderColor: "#d9e0e7",
          handleStyle: { color: "#98a2b3" },
          textStyle: { color: "#667085" },
        },
      ],
      axisPointer: { link: [{ xAxisIndex: "all" }] },

      grid: [
        { left: 78, right: 132, top: 58, height: 165 },
        { left: 78, right: 132, top: 318, height: 105 },
        { left: 78, right: 132, top: 508, height: 105 },
        { left: 78, right: 132, top: 713, height: 110 },
        { left: 78, right: 132, top: 898, height: 190 },
      ],
      xAxis: [0, 1, 2, 3, 4].map((gridIndex) => ({
        type: "time",
        gridIndex,
        min: start || undefined,
        max: end || undefined,
        axisLine: { lineStyle: { color: "#b9c3cf" } },
        axisTick: { lineStyle: { color: "#b9c3cf" } },
        axisLabel: {
          color: "#667085",
          formatter: (value) => formatUtc(value).replace(" UTC", ""),
        },
        splitLine: { show: false },
      })),
      yAxis: [
        {
          type: "value",
          gridIndex: 0,
          scale: true,
          axisLabel: { color: "#667085", formatter: (value) => formatPrice(value) },
          splitLine: { lineStyle: { color: "#edf2f7" } },
        },
        {
          type: "value",
          gridIndex: 1,
          name: "flow / CVD",
          nameTextStyle: { color: "#667085", fontSize: 11 },
          axisLabel: {
            color: "#667085",
            formatter: (value) => formatCompactUsd(invertSignedLogNetTaker(value)),
          },
          splitLine: { lineStyle: { color: "#edf2f7" } },
        },
        {
          type: "value",
          gridIndex: 2,
          min: -1,
          max: 1,
          name: "micro lean",
          nameTextStyle: { color: "#c11574", fontSize: 11 },
          axisLabel: { color: "#c11574", formatter: (value) => formatDecimal(value, 1) },
          splitLine: { lineStyle: { color: "#edf2f7" } },
        },
        {
          type: "value",
          gridIndex: 3,
          min: -1,
          max: 1,
          name: "imbalance",
          nameTextStyle: { color: "#667085", fontSize: 11 },
          axisLabel: { color: "#667085", formatter: (value) => formatDecimal(value, 1) },
          splitLine: { lineStyle: { color: "#edf2f7" } },
        },
        {
          type: "value",
          gridIndex: 3,
          position: "right",
          name: "spread",
          nameTextStyle: { color: "#b54708", fontSize: 11 },
          axisLabel: { color: "#b54708", formatter: formatBps },
          splitLine: { show: false },
        },
        {
          type: "value",
          gridIndex: 1,
          position: "right",
          scale: true,
          name: "Micropressure",
          nameTextStyle: { color: "#c11574", fontSize: 11 },
          axisLabel: { color: "#c11574", formatter: (value) => formatDecimal(value, 1) },
          splitLine: { show: false },
        },
        {
          type: "value",
          gridIndex: 4,
          scale: true,
          min: (value) => Math.min(value.min, 0),
          max: (value) => Math.max(value.max, 0),
          name: "OI change",
          nameTextStyle: { color: "#0e7490", fontSize: 11 },
          axisLabel: { color: "#0e7490", formatter: formatSignedCompactUsd },
          splitLine: { lineStyle: { color: "#edf2f7" } },
        },
        {
          type: "value",
          gridIndex: 4,
          position: "right",
          scale: true,
          min: (value) => Math.min(value.min, 0),
          max: (value) => Math.max(value.max, 0),
          name: "Mark/index",
          nameTextStyle: { color: "#c11574", fontSize: 11 },
          axisLine: { lineStyle: { color: "#c11574" } },
          axisLabel: { color: "#c11574", formatter: formatBps },
          splitLine: { show: false },
        },
        {
          type: "value",
          gridIndex: 4,
          position: "right",
          offset: 68,
          scale: true,
          name: "BTC price",
          nameTextStyle: { color: "#475467", fontSize: 11 },
          axisLabel: { color: "#475467", formatter: formatPrice },
          splitLine: { show: false },
        },
        {
          type: "value",
          gridIndex: 0,
          position: "right",
          min: 0,
          max: 1,
          name: "Market",
          nameTextStyle: { color: "#475467", fontSize: 11 },
          axisLabel: { color: "#475467", formatter: formatProbability },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: "BTC price",
          type: "line",
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: priceData,
          showSymbol: false,
          lineStyle: { color: "#175cd3", width: 2.5 },
          areaStyle: { color: "rgba(23, 92, 211, 0.08)" },
          emphasis: { focus: "series" },
        },
        {
          name: "WS mid",
          type: "line",
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: wsMidData,
          showSymbol: false,
          lineStyle: { color: "#344054", width: 1.35 },
          emphasis: { focus: "series" },
        },
        {
          name: "Market Up",
          type: "line",
          xAxisIndex: 0,
          yAxisIndex: 9,
          data: marketUpData,
          showSymbol: false,
          lineStyle: { color: "#039855", width: 1.8 },
          emphasis: { focus: "series" },
        },
        {
          name: "Market Down",
          type: "line",
          xAxisIndex: 0,
          yAxisIndex: 9,
          data: marketDownData,
          showSymbol: false,
          lineStyle: { color: "#d92d20", width: 1.8 },
          emphasis: { focus: "series" },
        },
        {
          name: "Net taker",
          type: "bar",
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: netTakerData,
          barMaxWidth: 12,
          itemStyle: {
            color: (params) => (Number(params.value?.[2]) >= 0 ? "#067647" : "#b42318"),
            opacity: 0.82,
          },
        },
        {
          name: "CVD",
          type: "line",
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: cvdData,
          showSymbol: false,
          lineStyle: { color: "#175cd3", width: 2 },
          markLine: {
            symbol: "none",
            silent: true,
            label: { show: false },
            lineStyle: { color: "#98a2b3", type: "dashed", width: 1 },
            data: [{ yAxis: 0 }],
          },
          emphasis: { focus: "series" },
        },
        {
          name: "Microprice pressure",
          type: "line",
          xAxisIndex: 1,
          yAxisIndex: 5,
          data: micropricePressureData,
          showSymbol: false,
          lineStyle: { color: "#c11574", width: 1.8 },
          emphasis: { focus: "series" },
        },
        {
          name: "Net liquidation",
          type: "bar",
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: netLiquidationData,
          barMaxWidth: 4,
          itemStyle: {
            color: (params) => (Number(params.value?.[2]) >= 0 ? "#0e7490" : "#c11574"),
            opacity: 0.58,
          },
        },
        {
          name: "Taker pressure 30s",
          type: "line",
          xAxisIndex: 3,
          yAxisIndex: 3,
          data: takerPressure30sData,
          showSymbol: false,
          lineStyle: { color: "#7a5af8", width: 1.8 },
          itemStyle: { color: "#7a5af8" },
        },
        {
          name: "Book imbalance",
          type: "line",
          xAxisIndex: 3,
          yAxisIndex: 3,
          data: bookImbalanceData,
          showSymbol: false,
          lineStyle: { color: "#067647", width: 1.8 },
          itemStyle: { color: "#067647" },
        },

        {
          name: "Microprice EWMA 3s",
          type: "line",
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: micropriceEwma3Data,
          showSymbol: false,
          lineStyle: { color: "#c11574", width: 1.8 },
          markLine: {
            symbol: "none",
            silent: true,
            label: { show: false },
            lineStyle: { color: "#98a2b3", type: "dashed", width: 1 },
            data: [{ yAxis: 0 }],
          },
        },
        {
          name: "Microprice 10s",
          type: "line",
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: micropriceAvg10Data,
          showSymbol: false,
          lineStyle: { color: "#155eef", width: 1.35, type: "dashed" },
        },
        {
          name: "Spread",
          type: "line",
          xAxisIndex: 3,
          yAxisIndex: 4,
          data: spreadData,
          showSymbol: false,
          lineStyle: { color: "#b54708", width: 1.5, type: "dashed" },
          itemStyle: { color: "#b54708" },
        },
        {
          name: "Open interest",
          type: "line",
          xAxisIndex: 4,
          yAxisIndex: 6,
          data: openInterestData,
          showSymbol: false,
          lineStyle: { color: "#0e7490", width: 1.8 },
        },
        {
          name: "Mark/index basis",
          type: "line",
          xAxisIndex: 4,
          yAxisIndex: 7,
          data: premiumData,
          showSymbol: false,
          lineStyle: { color: "#c11574", width: 1.8 },
          markLine: {
            symbol: "none",
            silent: true,
            label: { show: false },
            lineStyle: { color: "#98a2b3", type: "dashed", width: 1 },
            data: [{ yAxis: 0 }],
          },
        },
        {
          name: "BTC on OI",
          type: "line",
          xAxisIndex: 4,
          yAxisIndex: 8,
          data: priceData,
          showSymbol: false,
          lineStyle: { color: "#475467", width: 1.6, opacity: 0.82 },
        },
      ],
    };
  }, [buckets, marketEnd, marketStart, micropriceBuckets, polymarketProbabilities, positionSeries, priceSeries, tradeFlow1s, webSocketSummaries]);

  useEffect(() => {
    if (!chartRef.current) return undefined;

    const chart = echarts.init(chartRef.current, null, { renderer: "canvas" });
    chart.setOption(option, true);

    const resizeObserver = new ResizeObserver(() => chart.resize());
    resizeObserver.observe(chartRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.dispose();
    };
  }, [option]);

  if (priceSeries.length < 2) {
    return <p className="muted">No price series for this market.</p>;
  }

  const topHelpTopics = HELP_TOPICS.filter(
    (topic) =>
      !FLOW_HELP_TOPIC_IDS.has(topic.id) &&
      !MICROPRICE_HELP_TOPIC_IDS.has(topic.id) &&
      !IMBALANCE_HELP_TOPIC_IDS.has(topic.id) &&
      !OI_HELP_TOPIC_IDS.has(topic.id) &&
      !HIDDEN_HELP_TOPIC_IDS.has(topic.id)
  );
  const flowHelpTopics = [...FLOW_HELP_TOPIC_IDS]
    .map((id) => HELP_TOPICS.find((topic) => topic.id === id))
    .filter(Boolean);
  const micropriceHelpTopics = HELP_TOPICS.filter((topic) => MICROPRICE_HELP_TOPIC_IDS.has(topic.id));
  const imbalanceHelpTopics = HELP_TOPICS.filter((topic) => IMBALANCE_HELP_TOPIC_IDS.has(topic.id));
  const oiHelpTopics = [...OI_HELP_TOPIC_IDS]
    .map((id) => HELP_TOPICS.find((topic) => topic.id === id))
    .filter(Boolean);

  return (
    <>
      <div className="chart-help-row" aria-label="Chart glossary">
        {topHelpTopics.map((topic) => (
          <button
            type="button"
            className={`chart-help-button ${activeTopHelpId === topic.id ? "chart-help-button-active" : ""}`}
            key={topic.id}
            onClick={() => {
              setActiveFlowHelpId(null);
              setActiveMicropriceHelpId(null);
              setActiveImbalanceHelpId(null);
              setActiveTopHelpId(activeTopHelpId === topic.id ? null : topic.id);
            }}
            aria-expanded={activeTopHelpId === topic.id}
          >
            <span>{topic.label}</span>
            <b>?</b>
          </button>
        ))}
      </div>
      {activeTopHelp ? (
        <div className="chart-help-note" role="note">
          <strong>{activeTopHelp.label}</strong>
          <p>{activeTopHelp.text}</p>
          {activeTopHelp.details ? (
            <ul>
              {activeTopHelp.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className="echarts-scroll">
        <div className="echarts-chart-stage">
          <div className="flow-panel-help-row" aria-label="Flow and CVD panel glossary">
            {flowHelpTopics.map((topic) => (
              <button
                type="button"
                className={`chart-help-button chart-help-button-compact ${activeFlowHelpId === topic.id ? "chart-help-button-active" : ""}`}
                key={topic.id}
                onClick={() => {
                  setActiveTopHelpId(null);
                  setActiveMicropriceHelpId(null);
                  setActiveImbalanceHelpId(null);
                  setActiveFlowHelpId(activeFlowHelpId === topic.id ? null : topic.id);
                }}
                aria-expanded={activeFlowHelpId === topic.id}
              >
                <span>{topic.label}</span>
                <b>?</b>
              </button>
            ))}
          </div>
          {activeFlowHelp ? (
            <div className="chart-help-note flow-panel-help-note" role="note">
              <strong>{activeFlowHelp.label}</strong>
              <p>{activeFlowHelp.text}</p>
              {activeFlowHelp.details ? (
                <ul>
                  {activeFlowHelp.details.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <div className="microprice-panel-help-row" aria-label="Micro lean panel glossary">
            {micropriceHelpTopics.map((topic) => (
              <button
                type="button"
                className={`chart-help-button chart-help-button-compact ${activeMicropriceHelpId === topic.id ? "chart-help-button-active" : ""}`}
                key={topic.id}
                onClick={() => {
                  setActiveTopHelpId(null);
                  setActiveFlowHelpId(null);
                  setActiveImbalanceHelpId(null);
                  setActiveMicropriceHelpId(activeMicropriceHelpId === topic.id ? null : topic.id);
                }}
                aria-expanded={activeMicropriceHelpId === topic.id}
              >
                <span>{topic.label}</span>
                <b>?</b>
              </button>
            ))}
          </div>
          {activeMicropriceHelp ? (
            <div className="chart-help-note microprice-panel-help-note" role="note">
              <strong>{activeMicropriceHelp.label}</strong>
              <p>{activeMicropriceHelp.text}</p>
              {activeMicropriceHelp.details ? (
                <ul>
                  {activeMicropriceHelp.details.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <div className="imbalance-panel-help-row" aria-label="Imbalance panel glossary">
            {imbalanceHelpTopics.map((topic) => (
              <button
                type="button"
                className={`chart-help-button chart-help-button-compact ${activeImbalanceHelpId === topic.id ? "chart-help-button-active" : ""}`}
                key={topic.id}
                onClick={() => {
                  setActiveTopHelpId(null);
                  setActiveFlowHelpId(null);
                  setActiveMicropriceHelpId(null);
                  setActiveImbalanceHelpId(activeImbalanceHelpId === topic.id ? null : topic.id);
                }}
                aria-expanded={activeImbalanceHelpId === topic.id}
              >
                <span>{topic.label}</span>
                <b>?</b>
              </button>
            ))}
          </div>
          {activeImbalanceHelp ? (
            <div className="chart-help-note imbalance-panel-help-note" role="note">
              <strong>{activeImbalanceHelp.label}</strong>
              <p>{activeImbalanceHelp.text}</p>
              {activeImbalanceHelp.details ? (
                <ul>
                  {activeImbalanceHelp.details.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <div className="oi-panel-help-row" aria-label="Positioning panel glossary">
            {oiHelpTopics.map((topic) => (
              <button
                type="button"
                className={`chart-help-button chart-help-button-compact ${activeOiHelpId === topic.id ? "chart-help-button-active" : ""}`}
                key={topic.id}
                onClick={() => {
                  setActiveTopHelpId(null);
                  setActiveFlowHelpId(null);
                  setActiveMicropriceHelpId(null);
                  setActiveImbalanceHelpId(null);
                  setActiveOiHelpId(activeOiHelpId === topic.id ? null : topic.id);
                }}
                aria-expanded={activeOiHelpId === topic.id}
              >
                <span>{topic.label}</span>
                <b>?</b>
              </button>
            ))}
          </div>
          {activeOiHelp ? (
            <div className="chart-help-note oi-panel-help-note" role="note">
              <strong>{activeOiHelp.label}</strong>
              <p>{activeOiHelp.text}</p>
              {activeOiHelp.details ? (
                <ul>
                  {activeOiHelp.details.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <div className="echarts-market-chart" ref={chartRef} />
        </div>
      </div>
    </>
  );
}
