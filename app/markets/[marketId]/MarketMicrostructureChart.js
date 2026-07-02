"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";

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
    id: "takerImbalance",
    label: "Taker imbalance",
    text: "Normalized aggressive flow: (taker buy quote - taker sell quote) / total taker quote. Values near +1 are buy-dominated; values near -1 are sell-dominated.",
  },
  {
    id: "microprice",
    label: "Microprice",
    text: "Microprice is the order book's center of gravity: (best ask * bid size + best bid * ask size) / (bid size + ask size). If bid size is heavier, microprice leans above the midprice toward the ask, which points to short-term upward pressure. If ask size is heavier, it leans below the midprice toward the bid, which points to short-term downward pressure.",
    details: [
      "The visible microprice lines are rolling average lean, not the raw one-second lean. The raw one-second lean can whip from +1 to -1 quickly, so the chart hides it and focuses on persistence.",
      "Microprice 10s is the average normalized lean over the last 10 valid seconds. It reacts faster and is useful for short bursts of book pressure.",
      "Microprice 30s is the average normalized lean over the last 30 valid seconds. It is slower but usually more useful because it filters noise and shows persistent pressure.",
      "Both visible lines stay on the -1 to +1 lean scale: above 0 = upward book pressure, below 0 = downward book pressure, near 0 = balanced. The separate pressure line can reach +30 or -70 because it accumulates one-second lean over time.",
    ],
  },
  {
    id: "bookImbalance",
    label: "Book imbalance",
    text: "Near-price liquidity balance inside 5 bps: (bid depth - ask depth) / (bid depth + ask depth). Positive means more bid liquidity; negative means more ask liquidity.",
  },
  {
    id: "spread",
    label: "Spread",
    text: "Best ask minus best bid, measured in basis points. Wider spread often means thinner or less stable liquidity. The WS spread line is the one-second WebSocket average.",
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
    text: "Perp mark price minus Binance index price in bps. This is the live 5-second mark/index basis from the mark-price endpoint, not the Binance /futures/data/basis feed. The dashed line is zero.",
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
      ${row("Taker imbalance", "Taker imbalance", (value) => formatDecimal(value, 3))}
      ${row("Book imbalance", "Book imbalance", (value) => formatDecimal(value, 3))}
      ${row("Microprice 10s", "Microprice 10s", (value) => formatDecimal(value, 3))}
      ${row("Microprice 30s", "Microprice 30s", (value) => formatDecimal(value, 3))}
      ${detailText("Micro signal", "Microprice 30s", 2)}
      ${row("Spread", "Spread", formatBps)}
      ${row("WS spread", "WS spread", formatBps)}
      ${detail("WS spread max", "WS spread", 2, formatBps)}
      ${row("Book updates", "Book updates", formatCount)}
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
  positionSeries = [],
  webSocketSummaries = [],
  micropriceBuckets = [],
  polymarketProbabilities = [],
}) {
  const chartRef = useRef(null);
  const [activeHelpId, setActiveHelpId] = useState(null);
  const activeHelp = HELP_TOPICS.find((topic) => topic.id === activeHelpId);

  const option = useMemo(() => {
    const priceData = priceSeries
      .map((sample) => [toTimeValue(sample.time), finiteNumber(sample.price)])
      .filter(([time, price]) => time !== null && price !== null);
    const bucketRows = buckets
      .map((bucket) => ({
        time: toTimeValue(bucket.bucket_start),
        netTaker: finiteNumber(bucket.net_taker_quote),
        cvdMarket: finiteNumber(bucket.cvd_market_quote),
        takerImbalance: finiteNumber(bucket.taker_imbalance),
        bookImbalance: finiteNumber(bucket.book_imbalance_5bps),
        spread: finiteNumber(bucket.spread_bps),
      }))
      .filter((bucket) => bucket.time !== null);
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

    const netTakerData = bucketRows
      .filter((bucket) => bucket.netTaker !== null)
      .map((bucket) => [bucket.time, signedLogNetTaker(bucket.netTaker), bucket.netTaker]);
    const cvdData = bucketRows
      .filter((bucket) => bucket.cvdMarket !== null)
      .map((bucket) => [bucket.time, signedLogNetTaker(bucket.cvdMarket), bucket.cvdMarket]);
    const takerImbalanceData = bucketRows
      .filter((bucket) => bucket.takerImbalance !== null)
      .map((bucket) => [bucket.time, bucket.takerImbalance]);
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
    const micropriceAvg10Data = micropriceRows
      .filter((bucket) => bucket.avgLean10s !== null)
      .map((bucket) => [bucket.time, bucket.avgLean10s, bucket.persistenceSignal]);
    const micropriceAvg30Data = micropriceRows
      .filter((bucket) => bucket.avgLean30s !== null)
      .map((bucket) => [bucket.time, bucket.avgLean30s, bucket.persistenceSignal]);
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
      legend: {
        top: 6,
        left: 10,
        itemWidth: 12,
        itemHeight: 8,
        textStyle: { color: "#475467", fontSize: 12 },
      },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross", link: [{ xAxisIndex: "all" }] },
        appendToBody: true,
        confine: true,
        formatter: buildTooltip,
      },
      dataZoom: [
        { type: "inside", xAxisIndex: [0, 1, 2, 3, 4, 5], filterMode: "none" },
        {
          type: "slider",
          xAxisIndex: [0, 1, 2, 3, 4, 5],
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
        { left: 78, right: 132, top: 290, height: 105 },
        { left: 78, right: 132, top: 455, height: 105 },
        { left: 78, right: 132, top: 620, height: 110 },
        { left: 78, right: 132, top: 790, height: 110 },
        { left: 78, right: 132, top: 960, height: 190 },
      ],
      xAxis: [0, 1, 2, 3, 4, 5].map((gridIndex) => ({
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
          name: "avg lean",
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
          gridIndex: 4,
          scale: true,
          name: "WS spread",
          nameTextStyle: { color: "#f79009", fontSize: 11 },
          axisLabel: { color: "#f79009", formatter: formatBps },
          splitLine: { lineStyle: { color: "#edf2f7" } },
        },
        {
          type: "value",
          gridIndex: 4,
          position: "right",
          min: 0,
          scale: true,
          name: "updates",
          nameTextStyle: { color: "#667085", fontSize: 11 },
          axisLabel: { color: "#667085", formatter: formatCount },
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
          gridIndex: 5,
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
          gridIndex: 5,
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
          gridIndex: 5,
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
          yAxisIndex: 11,
          data: marketUpData,
          showSymbol: false,
          lineStyle: { color: "#039855", width: 1.8 },
          emphasis: { focus: "series" },
        },
        {
          name: "Market Down",
          type: "line",
          xAxisIndex: 0,
          yAxisIndex: 11,
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
          yAxisIndex: 7,
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
          name: "Taker imbalance",
          type: "line",
          xAxisIndex: 3,
          yAxisIndex: 3,
          data: takerImbalanceData,
          showSymbol: false,
          lineStyle: { color: "#7a5af8", width: 1.8 },
        },
        {
          name: "Book imbalance",
          type: "line",
          xAxisIndex: 3,
          yAxisIndex: 3,
          data: bookImbalanceData,
          showSymbol: false,
          lineStyle: { color: "#067647", width: 1.8 },
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
          name: "Microprice 30s",
          type: "line",
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: micropriceAvg30Data,
          showSymbol: false,
          lineStyle: { color: "#7a5af8", width: 1.35, type: "dotted" },
        },
        {
          name: "Spread",
          type: "line",
          xAxisIndex: 3,
          yAxisIndex: 4,
          data: spreadData,
          showSymbol: false,
          lineStyle: { color: "#b54708", width: 1.5, type: "dashed" },
        },
        {
          name: "WS spread",
          type: "line",
          xAxisIndex: 4,
          yAxisIndex: 5,
          data: wsSpreadData,
          showSymbol: false,
          lineStyle: { color: "#f79009", width: 1.8 },
        },
        {
          name: "Book updates",
          type: "bar",
          xAxisIndex: 4,
          yAxisIndex: 6,
          data: bookUpdateData,
          barMaxWidth: 4,
          itemStyle: { color: "#667085", opacity: 0.34 },
        },
        {
          name: "Open interest",
          type: "line",
          xAxisIndex: 5,
          yAxisIndex: 8,
          data: openInterestData,
          showSymbol: false,
          lineStyle: { color: "#0e7490", width: 1.8 },
        },
        {
          name: "Mark/index basis",
          type: "line",
          xAxisIndex: 5,
          yAxisIndex: 9,
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
          xAxisIndex: 5,
          yAxisIndex: 10,
          data: priceData,
          showSymbol: false,
          lineStyle: { color: "#475467", width: 1.6, opacity: 0.82 },
        },
      ],
    };
  }, [buckets, marketEnd, marketStart, micropriceBuckets, polymarketProbabilities, positionSeries, priceSeries, webSocketSummaries]);

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

  return (
    <>
      <div className="chart-help-row" aria-label="Chart glossary">
        {HELP_TOPICS.map((topic) => (
          <button
            type="button"
            className={`chart-help-button ${activeHelpId === topic.id ? "chart-help-button-active" : ""}`}
            key={topic.id}
            onClick={() => setActiveHelpId(activeHelpId === topic.id ? null : topic.id)}
            aria-expanded={activeHelpId === topic.id}
          >
            <span>{topic.label}</span>
            <b>?</b>
          </button>
        ))}
      </div>
      {activeHelp ? (
        <div className="chart-help-note" role="note">
          <strong>{activeHelp.label}</strong>
          <p>{activeHelp.text}</p>
          {activeHelp.details ? (
            <ul>
              {activeHelp.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className="echarts-scroll">
        <div className="echarts-market-chart" ref={chartRef} />
      </div>
    </>
  );
}
