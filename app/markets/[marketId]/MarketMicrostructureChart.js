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
    id: "netTaker",
    label: "Net taker",
    text: "Aggressive buy notional minus aggressive sell notional for each interval. Positive means taker buyers dominated; negative means taker sellers dominated. Bars use a signed log visual scale, but tooltips show raw dollars.",
  },
  {
    id: "takerImbalance",
    label: "Taker imbalance",
    text: "Normalized aggressive flow: (taker buy quote - taker sell quote) / total taker quote. Values near +1 are buy-dominated; values near -1 are sell-dominated.",
  },
  {
    id: "bookImbalance",
    label: "Book imbalance",
    text: "Near-price liquidity balance inside 5 bps: (bid depth - ask depth) / (bid depth + ask depth). Positive means more bid liquidity; negative means more ask liquidity.",
  },
  {
    id: "spread",
    label: "Spread",
    text: "Best ask minus best bid, measured in basis points. Wider spread often means thinner or less stable liquidity.",
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

  function row(label, seriesName, formatter) {
    const item = byName.get(seriesName);
    if (!item) return "";
    return `<div><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${item.color};margin-right:6px"></span>${label}: <b>${formatter(item.value?.[2] ?? item.value?.[1])}</b></div>`;
  }

  return `
    <div style="min-width:220px">
      <div style="font-weight:700;margin-bottom:6px">${formatUtc(time)}</div>
      ${row("BTC price", "BTC price", formatPrice)}
      ${row("Net taker", "Net taker", formatCompactUsd)}
      ${row("Taker imbalance", "Taker imbalance", (value) => formatDecimal(value, 3))}
      ${row("Book imbalance", "Book imbalance", (value) => formatDecimal(value, 3))}
      ${row("Spread", "Spread", (value) => `${formatDecimal(value, 2)} bps`)}
    </div>
  `;
}

export default function MarketMicrostructureChart({ marketStart, marketEnd, priceSeries, buckets }) {
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
        takerImbalance: finiteNumber(bucket.taker_imbalance),
        bookImbalance: finiteNumber(bucket.book_imbalance_5bps),
        spread: finiteNumber(bucket.spread_bps),
      }))
      .filter((bucket) => bucket.time !== null);

    const netTakerData = bucketRows
      .filter((bucket) => bucket.netTaker !== null)
      .map((bucket) => [bucket.time, signedLogNetTaker(bucket.netTaker), bucket.netTaker]);
    const takerImbalanceData = bucketRows
      .filter((bucket) => bucket.takerImbalance !== null)
      .map((bucket) => [bucket.time, bucket.takerImbalance]);
    const bookImbalanceData = bucketRows
      .filter((bucket) => bucket.bookImbalance !== null)
      .map((bucket) => [bucket.time, bucket.bookImbalance]);
    const spreadData = bucketRows
      .filter((bucket) => bucket.spread !== null)
      .map((bucket) => [bucket.time, bucket.spread]);

    const start = toTimeValue(marketStart);
    const end = toTimeValue(marketEnd);

    return {
      animation: false,
      backgroundColor: "#fbfcfe",
      color: ["#175cd3", "#067647", "#b42318", "#7a5af8", "#b54708"],
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
        { type: "inside", xAxisIndex: [0, 1, 2], filterMode: "none" },
        {
          type: "slider",
          xAxisIndex: [0, 1, 2],
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
        { left: 78, right: 72, top: 50, height: 190 },
        { left: 78, right: 72, top: 282, height: 105 },
        { left: 78, right: 72, top: 430, height: 125 },
      ],
      xAxis: [0, 1, 2].map((gridIndex) => ({
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
          name: "signed log scale",
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
          axisLabel: { color: "#667085", formatter: (value) => formatDecimal(value, 1) },
          splitLine: { lineStyle: { color: "#edf2f7" } },
        },
        {
          type: "value",
          gridIndex: 2,
          position: "right",
          axisLabel: { color: "#b54708", formatter: (value) => `${Number(value).toFixed(2)} bps` },
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
          name: "Taker imbalance",
          type: "line",
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: takerImbalanceData,
          showSymbol: false,
          lineStyle: { color: "#7a5af8", width: 1.8 },
        },
        {
          name: "Book imbalance",
          type: "line",
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: bookImbalanceData,
          showSymbol: false,
          lineStyle: { color: "#067647", width: 1.8 },
        },
        {
          name: "Spread",
          type: "line",
          xAxisIndex: 2,
          yAxisIndex: 3,
          data: spreadData,
          showSymbol: false,
          lineStyle: { color: "#b54708", width: 1.5, type: "dashed" },
        },
      ],
    };
  }, [buckets, marketEnd, marketStart, priceSeries]);

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
        </div>
      ) : null}
      <div className="echarts-scroll">
        <div className="echarts-market-chart" ref={chartRef} />
      </div>
    </>
  );
}
