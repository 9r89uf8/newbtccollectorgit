import {
  POLYMARKET_CLOB_WS_PING_INTERVAL_MS,
  POLYMARKET_CLOB_WS_SOURCE,
  POLYMARKET_CLOB_WS_SYNC_INTERVAL_MS,
  POLYMARKET_METADATA_PREFETCH_LEAD_MS,
} from "./config.mjs";
import { getMarketWindow } from "./time.mjs";
import { noteLiveReconnect, observePolymarketMetadata, observePolymarketQuote } from "./liveState.mjs";
import { getPolymarketMarketMetadata, slugForMarket } from "./polymarketSamples.mjs";
import { recordError, upsertMarket } from "./store.mjs";

const OPEN_STATE = 1;
const CLOSING_STATE = 2;
const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const UNSUBSCRIBE_GRACE_MS = 15000;

function createState() {
  return {
    ws: null,
    stopped: false,
    reconnectTimer: null,
    syncTimer: null,
    pingTimer: null,
    reconnectDelayMs: RECONNECT_INITIAL_MS,
    subscribedAssets: new Set(),
    wantedAssets: new Set(),
    assetMap: new Map(),
    staleSinceByAsset: new Map(),
    lastErrorRecordedAt: 0,
  };
}

function messageToText(message) {
  if (typeof message === "string") return message;
  if (message instanceof ArrayBuffer) return Buffer.from(message).toString("utf8");
  if (ArrayBuffer.isView(message)) return Buffer.from(message.buffer).toString("utf8");
  return "";
}

function readNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function bestBidFromLevels(levels) {
  if (!Array.isArray(levels)) return null;
  let best = null;
  for (const level of levels) {
    const price = readNumber(level?.price);
    const size = readNumber(level?.size);
    if (price === null || size === null || size <= 0) continue;
    best = best === null ? price : Math.max(best, price);
  }
  return best;
}

function bestAskFromLevels(levels) {
  if (!Array.isArray(levels)) return null;
  let best = null;
  for (const level of levels) {
    const price = readNumber(level?.price);
    const size = readNumber(level?.size);
    if (price === null || size === null || size <= 0) continue;
    best = best === null ? price : Math.min(best, price);
  }
  return best;
}

async function recordClobError(state, errorType, message) {
  const now = Date.now();
  if (now - state.lastErrorRecordedAt < 5000) return;
  state.lastErrorRecordedAt = now;

  try {
    await recordError({
      marketId: null,
      source: POLYMARKET_CLOB_WS_SOURCE.source,
      errorType,
      message,
    });
  } catch (error) {
    console.error(error);
  }
}

function sendJson(ws, payload) {
  ws.send(JSON.stringify(payload));
}

function subscribeAssets(state, assetIds) {
  if (!state.ws || state.ws.readyState !== OPEN_STATE || assetIds.length === 0) return;
  const payload = {
    assets_ids: assetIds,
    type: "market",
    custom_feature_enabled: true,
  };
  if (state.subscribedAssets.size > 0) {
    payload.operation = "subscribe";
  }
  sendJson(state.ws, payload);
  for (const assetId of assetIds) state.subscribedAssets.add(assetId);
}

function unsubscribeAssets(state, assetIds) {
  if (!state.ws || state.ws.readyState !== OPEN_STATE || assetIds.length === 0) return;
  sendJson(state.ws, {
    assets_ids: assetIds,
    operation: "unsubscribe",
  });
  for (const assetId of assetIds) state.subscribedAssets.delete(assetId);
}

async function addMarketSubscriptionTarget(state, market) {
  await upsertMarket(market);
  const metadata = await getPolymarketMarketMetadata(market);
  observePolymarketMetadata(market, metadata);

  const pairs = [
    [metadata.upTokenId, "up"],
    [metadata.downTokenId, "down"],
  ].filter(([assetId]) => assetId);

  for (const [assetId, side] of pairs) {
    const id = String(assetId);
    state.wantedAssets.add(id);
    state.assetMap.set(id, {
      marketId: market.id,
      side,
      slug: metadata.slug || slugForMarket(market),
    });
    state.staleSinceByAsset.delete(id);
  }
}

async function syncSubscriptions(state) {
  if (state.stopped) return;

  const nowMs = Date.now();
  const current = getMarketWindow(new Date(nowMs));
  const next = getMarketWindow(new Date(current.endMs));
  const priorWanted = new Set(state.wantedAssets);
  state.wantedAssets = new Set();

  const targets = [current];
  if (next.startMs - nowMs <= POLYMARKET_METADATA_PREFETCH_LEAD_MS) {
    targets.push(next);
  }

  for (const market of targets) {
    try {
      await addMarketSubscriptionTarget(state, market);
    } catch (error) {
      await recordClobError(
        state,
        error.name === "AbortError" ? "timeout" : "polymarket_clob_metadata_error",
        error.message || String(error)
      );
    }
  }

  const toSubscribe = [...state.wantedAssets].filter((assetId) => !state.subscribedAssets.has(assetId));
  subscribeAssets(state, toSubscribe);

  for (const assetId of priorWanted) {
    if (!state.wantedAssets.has(assetId) && !state.staleSinceByAsset.has(assetId)) {
      state.staleSinceByAsset.set(assetId, nowMs);
    }
  }

  const toUnsubscribe = [];
  for (const assetId of state.subscribedAssets) {
    if (state.wantedAssets.has(assetId)) continue;
    const staleSince = state.staleSinceByAsset.get(assetId) || nowMs;
    state.staleSinceByAsset.set(assetId, staleSince);
    if (nowMs - staleSince >= UNSUBSCRIBE_GRACE_MS) {
      toUnsubscribe.push(assetId);
      state.assetMap.delete(assetId);
      state.staleSinceByAsset.delete(assetId);
    }
  }
  unsubscribeAssets(state, toUnsubscribe);
}

function observeAssetQuote(state, assetId, values) {
  const mapping = state.assetMap.get(String(assetId));
  if (!mapping) return;
  observePolymarketQuote({
    marketId: mapping.marketId,
    side: mapping.side,
    ...values,
  });
}

function handleClobEvent(state, event) {
  const type = event?.event_type;
  if (!type) return;

  if (type === "book") {
    observeAssetQuote(state, event.asset_id, {
      bid: bestBidFromLevels(event.bids),
      ask: bestAskFromLevels(event.asks),
      eventTs: readNumber(event.timestamp),
    });
    return;
  }

  if (type === "price_change") {
    const changes = Array.isArray(event.price_changes) ? event.price_changes : [];
    for (const change of changes) {
      observeAssetQuote(state, change.asset_id, {
        bid: change.best_bid,
        ask: change.best_ask,
        eventTs: readNumber(event.timestamp),
      });
    }
    return;
  }

  if (type === "best_bid_ask") {
    observeAssetQuote(state, event.asset_id, {
      bid: event.best_bid,
      ask: event.best_ask,
      eventTs: readNumber(event.timestamp),
    });
    return;
  }

  if (type === "last_trade_price") {
    observeAssetQuote(state, event.asset_id, {
      lastTradePrice: event.price,
      eventTs: readNumber(event.timestamp),
    });
  }
}

function handleMessage(state, message) {
  const text = messageToText(message);
  if (!text || text === "PONG") return;
  const parsed = JSON.parse(text);
  const events = Array.isArray(parsed) ? parsed : [parsed];
  for (const event of events) {
    handleClobEvent(state, event);
  }
}

function scheduleReconnect(state) {
  if (state.stopped || state.reconnectTimer) return;
  const delayMs = state.reconnectDelayMs;
  state.reconnectDelayMs = Math.min(state.reconnectDelayMs * 2, RECONNECT_MAX_MS);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connect(state);
  }, delayMs);
  state.reconnectTimer.unref?.();
}

function connect(state) {
  if (state.stopped) return;

  if (!globalThis.WebSocket) {
    recordClobError(state, "websocket_unavailable", "Node runtime does not provide global WebSocket");
    return;
  }

  const ws = new globalThis.WebSocket(POLYMARKET_CLOB_WS_SOURCE.url);
  state.ws = ws;

  ws.addEventListener("open", () => {
    state.reconnectDelayMs = RECONNECT_INITIAL_MS;
    state.subscribedAssets.clear();
    syncSubscriptions(state).catch((error) => {
      recordClobError(state, "polymarket_clob_sync_error", error.message || String(error));
    });
  });

  ws.addEventListener("message", (event) => {
    try {
      handleMessage(state, event.data);
    } catch (error) {
      recordClobError(state, "polymarket_clob_message_error", error.message || String(error));
    }
  });

  ws.addEventListener("error", () => {
    recordClobError(state, "polymarket_clob_websocket_error", "Polymarket CLOB WebSocket emitted an error");
  });

  ws.addEventListener("close", (event) => {
    if (state.ws === ws) state.ws = null;
    if (!state.stopped) {
      noteLiveReconnect(POLYMARKET_CLOB_WS_SOURCE.source);
      recordClobError(
        state,
        "polymarket_clob_websocket_closed",
        `Polymarket CLOB WebSocket closed with code ${event.code || 0}`
      );
      scheduleReconnect(state);
    }
  });
}

export function startPolymarketClobLiveCollector() {
  const state = createState();
  connect(state);

  state.syncTimer = setInterval(() => {
    syncSubscriptions(state).catch((error) => {
      recordClobError(state, "polymarket_clob_sync_error", error.message || String(error));
    });
  }, POLYMARKET_CLOB_WS_SYNC_INTERVAL_MS);
  state.syncTimer.unref?.();

  state.pingTimer = setInterval(() => {
    if (state.ws && state.ws.readyState === OPEN_STATE) {
      try {
        state.ws.send("PING");
      } catch (error) {
        recordClobError(state, "polymarket_clob_ping_error", error.message || String(error));
      }
    }
  }, POLYMARKET_CLOB_WS_PING_INTERVAL_MS);
  state.pingTimer.unref?.();

  return {
    async stop() {
      state.stopped = true;
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      if (state.syncTimer) clearInterval(state.syncTimer);
      if (state.pingTimer) clearInterval(state.pingTimer);
      if (state.ws && [OPEN_STATE, CLOSING_STATE].includes(state.ws.readyState)) {
        state.ws.close(1000, "collector stopping");
      }
      state.ws = null;
    },
  };
}

