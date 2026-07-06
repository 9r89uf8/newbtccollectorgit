import { query } from "../lib/db.js";
import {
  COLLECTOR_NAME,
  FUTURES_WEBSOCKET_SOURCE,
  FUTURES_WS_FLUSH_INTERVAL_MS,
  FUTURES_WS_FLUSH_LAG_MS,
  FUTURES_WS_RECONNECT_INITIAL_MS,
  FUTURES_WS_RECONNECT_MAX_MS,
  FUTURES_WS_STALE_MS,
  FUTURES_WS_SUMMARY_BUCKET_MS,
  SYMBOL,
} from "./config.mjs";
import { getMarketWindow, toIsoSeconds } from "./time.mjs";
import { heartbeat, markMarketIncomplete, recordError, upsertMarket } from "./store.mjs";
import {
  noteLiveReconnect,
  observeBinanceAggTrade,
  observeBinanceBookTicker,
  observeBinanceForceOrder,
  observeBinanceMarkPrice,
} from "./liveState.mjs";

const OPEN_STATE = 1;
const CLOSING_STATE = 2;

const SUMMARY_COLUMNS = [
  "source",
  "instrument_type",
  "symbol",
  "bucket_start",
  "bucket_end",
  "first_event_time",
  "last_event_time",
  "event_count",
  "book_ticker_update_count",
  "bid_price_move_count",
  "ask_price_move_count",
  "mid_price_move_count",
  "best_bid_price_open",
  "best_bid_price_close",
  "best_bid_price_min",
  "best_bid_price_max",
  "best_bid_qty_open",
  "best_bid_qty_close",
  "best_bid_qty_min",
  "best_bid_qty_max",
  "best_ask_price_open",
  "best_ask_price_close",
  "best_ask_price_min",
  "best_ask_price_max",
  "best_ask_qty_open",
  "best_ask_qty_close",
  "best_ask_qty_min",
  "best_ask_qty_max",
  "mid_price_open",
  "mid_price_close",
  "mid_price_low",
  "mid_price_high",
  "mid_return_bps",
  "spread_bps_open",
  "spread_bps_close",
  "spread_bps_avg",
  "spread_bps_max",
  "microprice_open",
  "microprice_close",
  "microprice_bps_from_mid_close",
  "liquidation_count",
  "liquidation_buy_quote",
  "liquidation_sell_quote",
  "liquidation_net_quote",
  "liquidation_max_quote",
  "avg_event_lag_ms",
  "max_event_lag_ms",
  "summary_quality",
  "updated_at",
];

const UPSERT_COLUMNS = SUMMARY_COLUMNS.filter(
  (column) => !["source", "symbol", "bucket_start"].includes(column)
);

function readPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function readNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function toDate(milliseconds) {
  return Number.isFinite(milliseconds) && milliseconds > 0 ? new Date(milliseconds) : null;
}

function bucketStartMs(milliseconds) {
  return Math.floor(milliseconds / FUTURES_WS_SUMMARY_BUCKET_MS) * FUTURES_WS_SUMMARY_BUCKET_MS;
}

function createBucket(startMs) {
  return {
    startMs,
    firstEventMs: null,
    lastEventMs: null,
    eventCount: 0,
    bookTickerUpdateCount: 0,
    bidPriceMoveCount: 0,
    askPriceMoveCount: 0,
    midPriceMoveCount: 0,
    spreadBpsSum: 0,
    spreadBpsCount: 0,
    liquidationCount: 0,
    liquidationBuyQuote: 0,
    liquidationSellQuote: 0,
    liquidationMaxQuote: null,
    eventLagMsSum: 0,
    eventLagMsCount: 0,
    maxEventLagMs: null,
    lastBidPrice: null,
    lastAskPrice: null,
    lastMidPrice: null,
  };
}

function getBucket(state, eventMs) {
  const startMs = bucketStartMs(eventMs);
  let bucket = state.buckets.get(startMs);
  if (!bucket) {
    bucket = createBucket(startMs);
    state.buckets.set(startMs, bucket);
  }
  return bucket;
}

function observeEvent(bucket, eventMs) {
  bucket.eventCount += 1;
  bucket.firstEventMs = bucket.firstEventMs === null ? eventMs : Math.min(bucket.firstEventMs, eventMs);
  bucket.lastEventMs = bucket.lastEventMs === null ? eventMs : Math.max(bucket.lastEventMs, eventMs);

  const lagMs = Date.now() - eventMs;
  if (Number.isFinite(lagMs) && lagMs >= 0) {
    bucket.eventLagMsSum += lagMs;
    bucket.eventLagMsCount += 1;
    bucket.maxEventLagMs = bucket.maxEventLagMs === null ? lagMs : Math.max(bucket.maxEventLagMs, lagMs);
  }
}

function observeOpenCloseMinMax(bucket, prefix, value) {
  if (!Number.isFinite(value)) return;

  const openKey = `${prefix}Open`;
  const closeKey = `${prefix}Close`;
  const minKey = `${prefix}Min`;
  const maxKey = `${prefix}Max`;

  if (bucket[openKey] === undefined) bucket[openKey] = value;
  bucket[closeKey] = value;
  bucket[minKey] = bucket[minKey] === undefined ? value : Math.min(bucket[minKey], value);
  bucket[maxKey] = bucket[maxKey] === undefined ? value : Math.max(bucket[maxKey], value);
}

function observeOpenCloseLowHigh(bucket, prefix, value) {
  if (!Number.isFinite(value)) return;

  const openKey = `${prefix}Open`;
  const closeKey = `${prefix}Close`;
  const lowKey = `${prefix}Low`;
  const highKey = `${prefix}High`;

  if (bucket[openKey] === undefined) bucket[openKey] = value;
  bucket[closeKey] = value;
  bucket[lowKey] = bucket[lowKey] === undefined ? value : Math.min(bucket[lowKey], value);
  bucket[highKey] = bucket[highKey] === undefined ? value : Math.max(bucket[highKey], value);
}

function observeOpenClose(bucket, prefix, value) {
  if (!Number.isFinite(value)) return;

  const openKey = `${prefix}Open`;
  const closeKey = `${prefix}Close`;

  if (bucket[openKey] === undefined) bucket[openKey] = value;
  bucket[closeKey] = value;
}

function handleBookTicker(state, data) {
  const bidPrice = readPositiveNumber(data.b);
  const bidQty = readNonNegativeNumber(data.B);
  const askPrice = readPositiveNumber(data.a);
  const askQty = readNonNegativeNumber(data.A);

  if (bidPrice === null || bidQty === null || askPrice === null || askQty === null) return;
  if (askPrice < bidPrice) return;
  observeBinanceBookTicker(data);

  const eventMs = Number(data.E || data.T || Date.now());
  const bucket = getBucket(state, eventMs);
  const midPrice = (bidPrice + askPrice) / 2;
  const spreadBps = midPrice > 0 ? ((askPrice - bidPrice) / midPrice) * 10000 : null;
  const microprice = bidQty + askQty > 0
    ? (askPrice * bidQty + bidPrice * askQty) / (bidQty + askQty)
    : null;

  observeEvent(bucket, eventMs);
  bucket.bookTickerUpdateCount += 1;

  if (bucket.lastBidPrice !== null && bidPrice !== bucket.lastBidPrice) bucket.bidPriceMoveCount += 1;
  if (bucket.lastAskPrice !== null && askPrice !== bucket.lastAskPrice) bucket.askPriceMoveCount += 1;
  if (bucket.lastMidPrice !== null && midPrice !== bucket.lastMidPrice) bucket.midPriceMoveCount += 1;

  bucket.lastBidPrice = bidPrice;
  bucket.lastAskPrice = askPrice;
  bucket.lastMidPrice = midPrice;

  observeOpenCloseMinMax(bucket, "bestBidPrice", bidPrice);
  observeOpenCloseMinMax(bucket, "bestBidQty", bidQty);
  observeOpenCloseMinMax(bucket, "bestAskPrice", askPrice);
  observeOpenCloseMinMax(bucket, "bestAskQty", askQty);
  observeOpenCloseLowHigh(bucket, "midPrice", midPrice);
  observeOpenClose(bucket, "microprice", microprice);

  if (spreadBps !== null) {
    observeOpenClose(bucket, "spreadBps", spreadBps);
    bucket.spreadBpsSum += spreadBps;
    bucket.spreadBpsCount += 1;
    bucket.spreadBpsMax = bucket.spreadBpsMax === undefined ? spreadBps : Math.max(bucket.spreadBpsMax, spreadBps);
  }
}

function handleLiquidation(state, data) {
  const order = data.o || {};
  const eventMs = Number(order.T || data.E || Date.now());
  const side = String(order.S || "").toUpperCase();
  const quantity = readPositiveNumber(order.z || order.q);
  const price = readPositiveNumber(order.ap || order.p);

  if (!quantity || !price || !["BUY", "SELL"].includes(side)) return;
  observeBinanceForceOrder(data);

  const quoteNotional = quantity * price;
  const bucket = getBucket(state, eventMs);

  observeEvent(bucket, eventMs);
  bucket.liquidationCount += 1;
  if (side === "BUY") {
    bucket.liquidationBuyQuote += quoteNotional;
  } else {
    bucket.liquidationSellQuote += quoteNotional;
  }
  bucket.liquidationMaxQuote = bucket.liquidationMaxQuote === null
    ? quoteNotional
    : Math.max(bucket.liquidationMaxQuote, quoteNotional);
}

function messageToText(message) {
  if (typeof message === "string") return message;
  if (message instanceof ArrayBuffer) return Buffer.from(message).toString("utf8");
  if (ArrayBuffer.isView(message)) return Buffer.from(message.buffer).toString("utf8");
  return "";
}

function handleMessage(state, message) {
  const text = messageToText(message);
  if (!text) return;

  const payload = JSON.parse(text);
  const stream = String(payload.stream || "");
  const data = payload.data || payload;
  const eventType = data.e;

  if (eventType === "bookTicker" || stream.endsWith("@bookTicker")) {
    state.lastBookTickerAt = Date.now();
    handleBookTicker(state, data);
  } else if (eventType === "forceOrder" || stream.endsWith("@forceOrder")) {
    handleLiquidation(state, data);
  } else if (eventType === "aggTrade" || stream.endsWith("@aggTrade")) {
    observeBinanceAggTrade(data);
  } else if (eventType === "markPriceUpdate" || stream.includes("@markPrice")) {
    observeBinanceMarkPrice(data);
  }
}

function roundedInteger(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
}

function finalizeBucket(bucket) {
  const midOpen = bucket.midPriceOpen ?? null;
  const midClose = bucket.midPriceClose ?? null;
  const microClose = bucket.micropriceClose ?? null;
  const spreadAvg = bucket.spreadBpsCount > 0 ? bucket.spreadBpsSum / bucket.spreadBpsCount : null;
  const avgLagMs = bucket.eventLagMsCount > 0 ? bucket.eventLagMsSum / bucket.eventLagMsCount : null;
  const liquidationNetQuote = bucket.liquidationBuyQuote - bucket.liquidationSellQuote;
  const summaryQuality = bucket.bookTickerUpdateCount > 0
    ? "complete"
    : bucket.liquidationCount > 0
      ? "partial"
      : "missing";

  return {
    source: FUTURES_WEBSOCKET_SOURCE.source,
    instrument_type: FUTURES_WEBSOCKET_SOURCE.instrumentType,
    symbol: SYMBOL,
    bucket_start: new Date(bucket.startMs),
    bucket_end: new Date(bucket.startMs + FUTURES_WS_SUMMARY_BUCKET_MS),
    first_event_time: toDate(bucket.firstEventMs),
    last_event_time: toDate(bucket.lastEventMs),
    event_count: bucket.eventCount,
    book_ticker_update_count: bucket.bookTickerUpdateCount,
    bid_price_move_count: bucket.bidPriceMoveCount,
    ask_price_move_count: bucket.askPriceMoveCount,
    mid_price_move_count: bucket.midPriceMoveCount,
    best_bid_price_open: bucket.bestBidPriceOpen ?? null,
    best_bid_price_close: bucket.bestBidPriceClose ?? null,
    best_bid_price_min: bucket.bestBidPriceMin ?? null,
    best_bid_price_max: bucket.bestBidPriceMax ?? null,
    best_bid_qty_open: bucket.bestBidQtyOpen ?? null,
    best_bid_qty_close: bucket.bestBidQtyClose ?? null,
    best_bid_qty_min: bucket.bestBidQtyMin ?? null,
    best_bid_qty_max: bucket.bestBidQtyMax ?? null,
    best_ask_price_open: bucket.bestAskPriceOpen ?? null,
    best_ask_price_close: bucket.bestAskPriceClose ?? null,
    best_ask_price_min: bucket.bestAskPriceMin ?? null,
    best_ask_price_max: bucket.bestAskPriceMax ?? null,
    best_ask_qty_open: bucket.bestAskQtyOpen ?? null,
    best_ask_qty_close: bucket.bestAskQtyClose ?? null,
    best_ask_qty_min: bucket.bestAskQtyMin ?? null,
    best_ask_qty_max: bucket.bestAskQtyMax ?? null,
    mid_price_open: midOpen,
    mid_price_close: midClose,
    mid_price_low: bucket.midPriceLow ?? null,
    mid_price_high: bucket.midPriceHigh ?? null,
    mid_return_bps: midOpen && midClose ? ((midClose - midOpen) / midOpen) * 10000 : null,
    spread_bps_open: bucket.spreadBpsOpen ?? null,
    spread_bps_close: bucket.spreadBpsClose ?? null,
    spread_bps_avg: spreadAvg,
    spread_bps_max: bucket.spreadBpsMax ?? null,
    microprice_open: bucket.micropriceOpen ?? null,
    microprice_close: microClose,
    microprice_bps_from_mid_close: microClose && midClose ? ((microClose - midClose) / midClose) * 10000 : null,
    liquidation_count: bucket.liquidationCount,
    liquidation_buy_quote: bucket.liquidationBuyQuote,
    liquidation_sell_quote: bucket.liquidationSellQuote,
    liquidation_net_quote: liquidationNetQuote,
    liquidation_max_quote: bucket.liquidationMaxQuote,
    avg_event_lag_ms: avgLagMs,
    max_event_lag_ms: roundedInteger(bucket.maxEventLagMs),
    summary_quality: summaryQuality,
    updated_at: new Date(),
  };
}

async function upsertSummary(row) {
  const placeholders = SUMMARY_COLUMNS.map((_, index) => `$${index + 1}`).join(", ");
  const updates = UPSERT_COLUMNS.map((column) => `${column} = excluded.${column}`).join(",\n        ");
  const values = SUMMARY_COLUMNS.map((column) => row[column]);

  await query(
    `
      insert into futures_ws_1s_summaries (${SUMMARY_COLUMNS.join(", ")})
      values (${placeholders})
      on conflict (source, symbol, bucket_start) do update set
        ${updates}
    `,
    values
  );
}

async function recordWebSocketError(state, errorType, message) {
  const now = Date.now();
  if (now - state.lastErrorRecordedAt < 5000) return;
  state.lastErrorRecordedAt = now;

  try {
    await recordError({
      marketId: null,
      source: FUTURES_WEBSOCKET_SOURCE.source,
      errorType,
      message,
    });
  } catch (error) {
    console.error(error);
  }
}

async function markCurrentMarketIncompleteForNoMessages(state, nowMs = Date.now()) {
  const market = getMarketWindow(new Date(nowMs));
  if (state.lastNoMessageMarketId === market.id) return;
  state.lastNoMessageMarketId = market.id;

  const message = `Binance futures WebSocket received no bookTicker messages for ${Math.round(
    FUTURES_WS_STALE_MS / 1000
  )} seconds as of ${toIsoSeconds(new Date(nowMs))}; marking market incomplete`;

  try {
    await upsertMarket(market);
    await markMarketIncomplete(market.id);
    await recordError({
      marketId: market.id,
      source: FUTURES_WEBSOCKET_SOURCE.source,
      errorType: "websocket_no_messages",
      message,
    });
    await heartbeat(COLLECTOR_NAME, "error", market.id, message);
  } catch (error) {
    console.error(error);
  }
}

async function handleNoRecentMessages(state) {
  const nowMs = Date.now();
  if (nowMs - state.lastBookTickerAt < FUTURES_WS_STALE_MS) return;

  await markCurrentMarketIncompleteForNoMessages(state, nowMs);

  for (const connection of state.connections) {
    if (connection.name === "public" && connection.ws && connection.ws.readyState === OPEN_STATE) {
      connection.ws.close(4000, "stale websocket");
    }
  }
}

async function flushDueBuckets(state, force = false) {
  const cutoffMs = force
    ? Number.POSITIVE_INFINITY
    : bucketStartMs(Date.now() - FUTURES_WS_FLUSH_LAG_MS);
  const dueStarts = [...state.buckets.keys()]
    .filter((startMs) => startMs <= cutoffMs)
    .sort((a, b) => a - b);

  for (const startMs of dueStarts) {
    const bucket = state.buckets.get(startMs);
    if (!bucket) continue;
    state.buckets.delete(startMs);

    const row = finalizeBucket(bucket);
    if (row.summary_quality === "missing") continue;
    await upsertSummary(row);
  }
}

function scheduleReconnect(state, connection) {
  if (state.stopped || connection.reconnectTimer) return;

  const delayMs = connection.reconnectDelayMs;
  connection.reconnectDelayMs = Math.min(connection.reconnectDelayMs * 2, FUTURES_WS_RECONNECT_MAX_MS);
  connection.reconnectTimer = setTimeout(() => {
    connection.reconnectTimer = null;
    connect(state, connection);
  }, delayMs);
  connection.reconnectTimer.unref?.();
}

function connect(state, connection) {
  if (state.stopped) return;

  if (!globalThis.WebSocket) {
    recordWebSocketError(state, "websocket_unavailable", "Node runtime does not provide global WebSocket");
    return;
  }

  const ws = new globalThis.WebSocket(connection.url);
  connection.ws = ws;

  ws.addEventListener("open", () => {
    connection.reconnectDelayMs = FUTURES_WS_RECONNECT_INITIAL_MS;
  });

  ws.addEventListener("message", (event) => {
    state.lastMessageAt = Date.now();
    try {
      handleMessage(state, event.data);
    } catch (error) {
      recordWebSocketError(
        state,
        "websocket_message_error",
        `${connection.name} connection: ${error.message || String(error)}`
      );
    }
  });

  ws.addEventListener("error", () => {
    recordWebSocketError(
      state,
      "websocket_error",
      `Binance futures ${connection.name} WebSocket emitted an error`
    );
  });

  ws.addEventListener("close", (event) => {
    if (connection.ws === ws) connection.ws = null;
    if (!state.stopped) {
      recordWebSocketError(
        state,
        "websocket_closed",
        `Binance futures ${connection.name} WebSocket closed with code ${event.code || 0}`
      );
      noteLiveReconnect(`${FUTURES_WEBSOCKET_SOURCE.source}:${connection.name}`);
      scheduleReconnect(state, connection);
    }
  });
}

export function startFuturesWebSocketSummaryCollector() {
  const state = {
    buckets: new Map(),
    flushTimer: null,
    connections: FUTURES_WEBSOCKET_SOURCE.connections().map((connection) => ({
      ...connection,
      reconnectTimer: null,
      reconnectDelayMs: FUTURES_WS_RECONNECT_INITIAL_MS,
      ws: null,
    })),
    lastErrorRecordedAt: 0,
    lastMessageAt: Date.now(),
    lastBookTickerAt: Date.now(),
    lastNoMessageMarketId: null,
    stopped: false,
  };

  for (const connection of state.connections) {
    connect(state, connection);
  }

  state.flushTimer = setInterval(() => {
    flushDueBuckets(state).catch((error) => {
      recordWebSocketError(state, "websocket_summary_flush_error", error.message || String(error));
    });
    handleNoRecentMessages(state).catch((error) => {
      recordWebSocketError(state, "websocket_no_message_watchdog_error", error.message || String(error));
    });
  }, FUTURES_WS_FLUSH_INTERVAL_MS);
  state.flushTimer.unref?.();

  return {
    async stop() {
      state.stopped = true;
      for (const connection of state.connections) {
        if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
        if (connection.ws && [OPEN_STATE, CLOSING_STATE].includes(connection.ws.readyState)) {
          connection.ws.close(1000, "collector stopping");
        }
      }
      if (state.flushTimer) clearInterval(state.flushTimer);
      await flushDueBuckets(state, true);
    },
  };
}




