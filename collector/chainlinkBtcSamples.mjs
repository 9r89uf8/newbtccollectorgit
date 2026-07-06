import { query } from "../lib/db.js";
import {
  POLYMARKET_RTDS_CHAINLINK_BTC_SOURCE,
  POLYMARKET_RTDS_PING_INTERVAL_MS,
  POLYMARKET_RTDS_RECONNECT_INITIAL_MS,
  POLYMARKET_RTDS_RECONNECT_MAX_MS,
  POLYMARKET_RTDS_STALE_MS,
} from "./config.mjs";
import { recordError } from "./store.mjs";
import { observeChainlinkTick } from "./liveState.mjs";

const OPEN_STATE = 1;
const CLOSING_STATE = 2;
const state = {
  ws: null,
  reconnectTimer: null,
  pingTimer: null,
  reconnectDelayMs: POLYMARKET_RTDS_RECONNECT_INITIAL_MS,
  stopped: true,
  latestTick: null,
  lastErrorRecordedAt: 0,
};

function readNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toDate(milliseconds) {
  return Number.isFinite(milliseconds) && milliseconds > 0 ? new Date(milliseconds) : null;
}

function messageToText(message) {
  if (typeof message === "string") return message;
  if (message instanceof ArrayBuffer) return Buffer.from(message).toString("utf8");
  if (ArrayBuffer.isView(message)) return Buffer.from(message.buffer).toString("utf8");
  return "";
}

function normalizeSymbol(value) {
  return String(value || "").trim().toLowerCase();
}

async function recordRtdsError(errorType, message) {
  const now = Date.now();
  if (now - state.lastErrorRecordedAt < 5000) return;
  state.lastErrorRecordedAt = now;

  try {
    await recordError({
      marketId: null,
      source: POLYMARKET_RTDS_CHAINLINK_BTC_SOURCE.source,
      errorType,
      message,
    });
  } catch (error) {
    console.error(error);
  }
}

function parseRtdsMessage(message) {
  const text = messageToText(message);
  if (!text || text === "PING" || text === "PONG") return null;

  const parsed = JSON.parse(text);
  if (parsed.topic !== POLYMARKET_RTDS_CHAINLINK_BTC_SOURCE.topic) return null;
  if (normalizeSymbol(parsed.payload?.symbol) !== normalizeSymbol(POLYMARKET_RTDS_CHAINLINK_BTC_SOURCE.rtdsSymbol)) {
    return null;
  }

  const price = readNumber(parsed.payload?.value);
  const priceTimestampMs = readNumber(parsed.payload?.timestamp);
  const serverTimestampMs = readNumber(parsed.timestamp);
  if (price === null || price <= 0) return null;

  return {
    topic: parsed.topic,
    type: parsed.type || null,
    rtdsSymbol: normalizeSymbol(parsed.payload?.symbol),
    price,
    priceTimestampMs,
    serverTimestampMs,
    receivedAtMs: Date.now(),
    raw: parsed,
  };
}

function handleMessage(message) {
  const tick = parseRtdsMessage(message);
  if (!tick) return;
  state.latestTick = tick;
  observeChainlinkTick(tick);
}

function scheduleReconnect() {
  if (state.stopped || state.reconnectTimer) return;

  const delayMs = state.reconnectDelayMs;
  state.reconnectDelayMs = Math.min(state.reconnectDelayMs * 2, POLYMARKET_RTDS_RECONNECT_MAX_MS);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connect();
  }, delayMs);
  state.reconnectTimer.unref?.();
}

function sendSubscribe(ws) {
  ws.send(JSON.stringify(POLYMARKET_RTDS_CHAINLINK_BTC_SOURCE.subscription()));
}

function connect() {
  if (state.stopped) return;

  if (!globalThis.WebSocket) {
    recordRtdsError("websocket_unavailable", "Node runtime does not provide global WebSocket");
    return;
  }

  const ws = new globalThis.WebSocket(POLYMARKET_RTDS_CHAINLINK_BTC_SOURCE.url);
  state.ws = ws;

  ws.addEventListener("open", () => {
    state.reconnectDelayMs = POLYMARKET_RTDS_RECONNECT_INITIAL_MS;
    try {
      sendSubscribe(ws);
    } catch (error) {
      recordRtdsError("polymarket_rtds_subscribe_error", error.message || String(error));
    }
  });

  ws.addEventListener("message", (event) => {
    try {
      handleMessage(event.data);
    } catch (error) {
      recordRtdsError("polymarket_rtds_message_error", error.message || String(error));
    }
  });

  ws.addEventListener("error", () => {
    recordRtdsError("polymarket_rtds_websocket_error", "Polymarket RTDS WebSocket emitted an error");
  });

  ws.addEventListener("close", (event) => {
    if (state.ws === ws) state.ws = null;
    if (!state.stopped) {
      recordRtdsError(
        "polymarket_rtds_websocket_closed",
        `Polymarket RTDS WebSocket closed with code ${event.code || 0}`
      );
      scheduleReconnect();
    }
  });
}

function latestSampleFromTick(scheduledAt) {
  const tick = state.latestTick;
  if (!tick) {
    return {
      price: null,
      priceTimestamp: null,
      serverTimestamp: null,
      tickAgeMs: null,
      quality: "missing",
      rawResponse: null,
    };
  }

  const priceTimestamp = toDate(tick.priceTimestampMs);
  const serverTimestamp = toDate(tick.serverTimestampMs);
  const referenceMs = Math.max(Date.now(), scheduledAt.getTime());
  const tickAgeMs = Number.isFinite(tick.priceTimestampMs)
    ? Math.max(0, Math.round(referenceMs - tick.priceTimestampMs))
    : null;
  const quality = tickAgeMs !== null && tickAgeMs <= POLYMARKET_RTDS_STALE_MS ? "complete" : "partial";

  return {
    price: tick.price,
    priceTimestamp,
    serverTimestamp,
    tickAgeMs,
    quality,
    rawResponse: tick.raw,
  };
}

async function insertPolymarketChainlinkSample(market, scheduledAt, sampleType, sample) {
  await query(
    `
      insert into chainlink_btc_price_samples
        (
          source,
          instrument_type,
          symbol,
          market_id,
          feed_id,
          topic,
          rtds_symbol,
          scheduled_at,
          collected_at,
          sample_type,
          price,
          bid,
          ask,
          valid_from_timestamp,
          observations_timestamp,
          price_timestamp,
          server_timestamp,
          expires_at,
          native_fee,
          link_fee,
          request_latency_ms,
          report_latency_ms,
          tick_age_ms,
          quality,
          decode_status,
          raw_response,
          full_report
        )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, now(), $9, $10, null,
        null, null, $11, $11, $12, null, null, null, null, $13,
        $13, $14, $15, $16::jsonb, null
      )
      on conflict (source, market_id, scheduled_at) do update set
        collected_at = excluded.collected_at,
        sample_type = excluded.sample_type,
        price = excluded.price,
        bid = excluded.bid,
        ask = excluded.ask,
        observations_timestamp = excluded.observations_timestamp,
        price_timestamp = excluded.price_timestamp,
        server_timestamp = excluded.server_timestamp,
        request_latency_ms = excluded.request_latency_ms,
        report_latency_ms = excluded.report_latency_ms,
        tick_age_ms = excluded.tick_age_ms,
        quality = excluded.quality,
        decode_status = excluded.decode_status,
        raw_response = excluded.raw_response,
        full_report = excluded.full_report,
        updated_at = now()
    `,
    [
      POLYMARKET_RTDS_CHAINLINK_BTC_SOURCE.source,
      POLYMARKET_RTDS_CHAINLINK_BTC_SOURCE.instrumentType,
      POLYMARKET_RTDS_CHAINLINK_BTC_SOURCE.symbol,
      market.id,
      POLYMARKET_RTDS_CHAINLINK_BTC_SOURCE.feedId,
      POLYMARKET_RTDS_CHAINLINK_BTC_SOURCE.topic,
      POLYMARKET_RTDS_CHAINLINK_BTC_SOURCE.rtdsSymbol,
      scheduledAt,
      sampleType,
      sample.price,
      sample.priceTimestamp,
      sample.serverTimestamp,
      sample.tickAgeMs,
      sample.quality,
      sample.price === null ? "missing" : "decoded",
      sample.rawResponse ? JSON.stringify(sample.rawResponse) : null,
    ]
  );
}

export function startPolymarketChainlinkBtcPriceCollector() {
  if (!state.stopped) return { stop: stopPolymarketChainlinkBtcPriceCollector };

  state.stopped = false;
  state.reconnectDelayMs = POLYMARKET_RTDS_RECONNECT_INITIAL_MS;
  connect();

  state.pingTimer = setInterval(() => {
    if (state.ws && state.ws.readyState === OPEN_STATE) {
      try {
        state.ws.send("PING");
      } catch (error) {
        recordRtdsError("polymarket_rtds_ping_error", error.message || String(error));
      }
    }
  }, POLYMARKET_RTDS_PING_INTERVAL_MS);
  state.pingTimer.unref?.();

  return { stop: stopPolymarketChainlinkBtcPriceCollector };
}

export async function stopPolymarketChainlinkBtcPriceCollector() {
  state.stopped = true;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.pingTimer) {
    clearInterval(state.pingTimer);
    state.pingTimer = null;
  }
  if (state.ws && [OPEN_STATE, CLOSING_STATE].includes(state.ws.readyState)) {
    state.ws.close(1000, "collector stopping");
  }
  state.ws = null;
}

export async function collectPolymarketChainlinkBtcPriceSamples(samples, scheduledAt) {
  const sample = latestSampleFromTick(scheduledAt);
  await Promise.all(
    samples.map((item) =>
      insertPolymarketChainlinkSample(item.market, scheduledAt, item.sampleType, sample)
    )
  );

  return {
    ok: sample.quality !== "missing",
    source: POLYMARKET_RTDS_CHAINLINK_BTC_SOURCE.source,
    quality: sample.quality,
    sampleCount: samples.length,
    tickAgeMs: sample.tickAgeMs,
  };
}

export async function collectPolymarketChainlinkBtcPriceSample(market, scheduledAt, sampleType) {
  return collectPolymarketChainlinkBtcPriceSamples([{ market, sampleType }], scheduledAt);
}
