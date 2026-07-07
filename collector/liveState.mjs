import { performance } from "node:perf_hooks";
import { query } from "../lib/db.js";
import {
  FUTURES_WS_SUMMARY_BUCKET_MS,
  LIVE_STATE_PERSIST_INTERVAL_MS,
  MARKET_MS,
  POSITION_SAMPLE_INTERVAL_MS,
  POLYMARKET_RTDS_STALE_MS,
  SYMBOL,
} from "./config.mjs";
import { getMarketWindow } from "./time.mjs";
import { slugForMarket } from "./polymarketSamples.mjs";

const SECOND_MS = FUTURES_WS_SUMMARY_BUCKET_MS || 1000;
const ROLLING_FLOW_WINDOW_MS = 30_000;
const BINANCE_STALE_MS = 5_000;
const POLYMARKET_STALE_MS = 10_000;
const POSITION_STALE_MS = Math.max(POSITION_SAMPLE_INTERVAL_MS * 3, 15_000);
const POSITION_ROLLING_WINDOW_MS = 60_000;
const MAX_POSITION_HISTORY_MS = 5 * 60_000;
const MAX_HISTORY_POINTS = 900;
const PRICE_TO_BEAT_CHAINLINK_GRACE_MS = 20_000;
const WEBSOCKET_BTC_PRICE_HISTORY_MS = 5 * 60_000;

const state = {
  market: null,
  binance: {
    bestBid: null,
    bestBidQty: null,
    bestAsk: null,
    bestAskQty: null,
    mid: null,
    spreadBps: null,
    microprice: null,
    micropriceLean: null,
    bookImbalance: null,
    bookEventTs: null,
    bookReceivedTs: null,
    eventLagMs: null,
    markPrice: null,
    indexPrice: null,
    fundingRate: null,
    nextFundingTime: null,
    markEventTs: null,
    markReceivedTs: null,
  },
  chainlink: {
    price: null,
    exchangeTs: null,
    serverTs: null,
    receivedTs: null,
    ageMs: null,
    quality: "missing",
  },
  position: createPositionState(),
  positionHistory: [],
  polymarket: {
    slug: null,
    conditionId: null,
    upTokenId: null,
    downTokenId: null,
    priceToBeat: null,
    endPrice: null,
    winningOutcome: "unknown",
    priceToBeatSource: null,
    up: createPolymarketSide(),
    down: createPolymarketSide(),
    normalizedUp: null,
    normalizedDown: null,
    probabilitySum: null,
    quality: "missing",
    metadataUpdatedTs: null,
  },
  currentBucket: createFlowBucket(bucketStartMs(Date.now())),
  flowHistory: [],
  websocketBtcPriceHistory: [],
  marketFlow: createMarketFlowTotals(),
  continuousCvdQuote: 0,
  micropricePressureMarket: 0,
  micropricePressureContinuous: 0,
  collector: {
    startedAt: Date.now(),
    lastPersistedAt: null,
    persistError: null,
    eventLoopLagMs: null,
    reconnectCount: 0,
    staleSources: [],
  },
  flusher: null,
  lagTimer: null,
};

function createPositionState() {
  return {
    openInterestBase: null,
    openInterestQuote: null,
    openInterestOpenBase: null,
    openInterestOpenQuote: null,
    openInterestChangeBase: null,
    openInterestChangeQuote: null,
    openInterestChangePct: null,
    openInterestChange1mBase: null,
    openInterestChange1mQuote: null,
    openInterestChange1mPct: null,
    openInterestRollingWindowMs: null,
    markPrice: null,
    indexPrice: null,
    premiumBps: null,
    fundingRate: null,
    nextFundingTime: null,
    markExchangeTs: null,
    openInterestExchangeTs: null,
    receivedTs: null,
    latencyMs: null,
  };
}
function createPolymarketSide() {
  return {
    bid: null,
    ask: null,
    mid: null,
    lastTradePrice: null,
    eventTs: null,
    receivedTs: null,
  };
}

function createMarketFlowTotals() {
  return {
    takerBuyQuote: 0,
    takerSellQuote: 0,
    netTakerQuote: 0,
    grossTakerQuote: 0,
    tradeCount: 0,
    liquidationBuyQuote: 0,
    liquidationSellQuote: 0,
    liquidationNetQuote: 0,
    liquidationCount: 0,
  };
}

function createFlowBucket(startMs) {
  return {
    startMs,
    endMs: startMs + SECOND_MS,
    takerBuyQuote: 0,
    takerSellQuote: 0,
    netTakerQuote: 0,
    grossTakerQuote: 0,
    tradeCount: 0,
    micropriceLean: null,
    micropriceSampleCount: 0,
    micropricePressureDelta: 0,
    micropricePressureFinalized: false,
    liquidationBuyQuote: 0,
    liquidationSellQuote: 0,
    liquidationNetQuote: 0,
    liquidationCount: 0,
  };
}

function bucketStartMs(ms) {
  return Math.floor(ms / SECOND_MS) * SECOND_MS;
}

function readNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readPositiveNumber(value) {
  const number = readNumber(value);
  return number !== null && number > 0 ? number : null;
}

function calculateBookImbalance(bestBidQty, bestAskQty) {
  if (bestBidQty === null || bestAskQty === null) return null;
  const depth = bestBidQty + bestAskQty;
  return depth > 0 ? (bestBidQty - bestAskQty) / depth : null;
}
function calculateMicropriceLean(mid, microprice, spreadBps) {
  if (mid === null || microprice === null || spreadBps === null || mid <= 0 || spreadBps === 0) return null;
  return (2 * (((microprice - mid) / mid) * 10000)) / spreadBps;
}

function micropriceBucketSeconds(bucket, nowMs = bucket?.endMs) {
  if (!bucket || !state.market) return 0;
  const startMs = Math.max(bucket.startMs, state.market.startMs);
  const endMs = Math.min(nowMs, bucket.endMs, state.market.endMs);
  return Math.max(0, (endMs - startMs) / 1000);
}

function finalizeMicropricePressure(bucket) {
  if (!bucket || bucket.micropricePressureFinalized) return;
  bucket.micropricePressureFinalized = true;
  const lean = readNumber(bucket.micropriceLean);
  if (lean === null) return;

  const seconds = micropriceBucketSeconds(bucket);
  if (seconds <= 0) return;

  const delta = lean * seconds;
  bucket.micropricePressureDelta = delta;
  state.micropricePressureMarket += delta;
  state.micropricePressureContinuous += delta;
}

function liveMicropricePressure(nowMs) {
  const lean = readNumber(state.currentBucket?.micropriceLean);
  const seconds = micropriceBucketSeconds(state.currentBucket, nowMs);
  const currentDelta = lean !== null && seconds > 0 ? lean * seconds : 0;

  return {
    micropriceLean: state.binance.micropriceLean,
    micropricePressureDelta1s: lean !== null ? currentDelta : null,
    micropricePressureMarket: state.micropricePressureMarket + currentDelta,
    micropricePressureContinuous: state.micropricePressureContinuous + currentDelta,
    micropriceSampleCount1s: state.currentBucket?.micropriceSampleCount || 0,
  };
}

function toIso(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function qualityFromAge(ageMs, staleMs) {
  if (ageMs === null) return "missing";
  return ageMs <= staleMs ? "complete" : "stale";
}

function sideSnapshot(side, nowMs) {
  const ageMs = side.receivedTs ? Math.max(0, nowMs - side.receivedTs) : null;
  return {
    bid: side.bid,
    ask: side.ask,
    mid: side.mid,
    lastTradePrice: side.lastTradePrice,
    ts: toIso(side.eventTs),
    receivedTs: toIso(side.receivedTs),
    ageMs,
    quality: qualityFromAge(ageMs, POLYMARKET_STALE_MS),
  };
}

function ensureCurrentMarket(nowMs = Date.now()) {
  const market = getMarketWindow(new Date(nowMs), SYMBOL);
  if (state.market?.id === market.id) return state.market;

  state.market = market;
  state.polymarket = {
    slug: slugForMarket(market),
    conditionId: null,
    upTokenId: null,
    downTokenId: null,
    priceToBeat: null,
    endPrice: null,
    winningOutcome: "unknown",
    priceToBeatSource: null,
    up: createPolymarketSide(),
    down: createPolymarketSide(),
    normalizedUp: null,
    normalizedDown: null,
    probabilitySum: null,
    quality: "missing",
    metadataUpdatedTs: null,
  };
  state.currentBucket = createFlowBucket(bucketStartMs(nowMs));
  state.flowHistory = [];
  state.marketFlow = createMarketFlowTotals();
  state.position = createPositionState();
  state.micropricePressureMarket = 0;

  return state.market;
}

function rollBuckets(nowMs = Date.now()) {
  ensureCurrentMarket(nowMs);
  const startMs = bucketStartMs(nowMs);
  if (!state.currentBucket || state.currentBucket.startMs === startMs) return;

  if (state.currentBucket.startMs >= state.market.startMs && state.currentBucket.startMs < state.market.endMs) {
    finalizeMicropricePressure(state.currentBucket);
    state.flowHistory.push({ ...state.currentBucket });
    if (state.flowHistory.length > MAX_HISTORY_POINTS) {
      state.flowHistory.splice(0, state.flowHistory.length - MAX_HISTORY_POINTS);
    }
  }

  state.currentBucket = createFlowBucket(startMs);
}

function rollingFlow(nowMs = Date.now()) {
  const cutoffMs = nowMs - ROLLING_FLOW_WINDOW_MS;
  const rows = state.flowHistory.filter((bucket) => bucket.startMs >= cutoffMs);
  if (state.currentBucket.startMs >= cutoffMs) rows.push(state.currentBucket);

  let rollingNet = 0;
  let rollingGross = 0;
  for (const row of rows) {
    rollingNet += row.netTakerQuote;
    rollingGross += row.grossTakerQuote;
  }

  return {
    rollingNet30s: rollingNet,
    rollingGross30s: rollingGross,
    rollingImbalance30s: rollingGross > 0 ? rollingNet / rollingGross : null,
  };
}

function setPriceToBeat(price, source) {
  const nextPrice = readPositiveNumber(price);
  if (nextPrice === null) return false;
  state.polymarket.priceToBeat = nextPrice;
  state.polymarket.priceToBeatSource = source;
  return true;
}

function maybeSetOpeningPriceToBeat(price, referenceMs) {
  if (!state.market || state.polymarket.priceToBeat !== null) return;
  if (!Number.isFinite(referenceMs)) return;
  if (referenceMs < state.market.startMs - 1000) return;
  if (referenceMs > state.market.startMs + PRICE_TO_BEAT_CHAINLINK_GRACE_MS) return;
  setPriceToBeat(price, "chainlink_open_live");
}

function updatePolymarketPairQuality() {
  const upMid = state.polymarket.up.mid;
  const downMid = state.polymarket.down.mid;

  if (upMid !== null && downMid !== null) {
    const sum = upMid + downMid;
    state.polymarket.probabilitySum = sum;
    state.polymarket.normalizedUp = sum > 0 ? upMid / sum : null;
    state.polymarket.normalizedDown = sum > 0 ? downMid / sum : null;
    state.polymarket.quality = sum > 0 ? "complete" : "partial";
    return;
  }

  state.polymarket.probabilitySum = null;
  state.polymarket.normalizedUp = null;
  state.polymarket.normalizedDown = null;
  state.polymarket.quality = upMid !== null || downMid !== null ? "partial" : "missing";
}

export function noteLiveReconnect(source) {
  state.collector.reconnectCount += 1;
  if (source) {
    state.collector.lastReconnectSource = source;
    state.collector.lastReconnectAt = Date.now();
  }
}

export function observePolymarketMetadata(market, metadata) {
  if (!market || !metadata) return;
  ensureCurrentMarket();
  if (state.market?.id !== market.id) return;

  state.polymarket.slug = metadata.slug || slugForMarket(market);
  state.polymarket.conditionId = metadata.conditionId || null;
  state.polymarket.upTokenId = metadata.upTokenId || null;
  state.polymarket.downTokenId = metadata.downTokenId || null;
  const priceToBeat = readNumber(metadata.priceToBeat);
  if (priceToBeat !== null) setPriceToBeat(priceToBeat, "gamma");
  const endPrice = readNumber(metadata.endPrice);
  if (endPrice !== null) state.polymarket.endPrice = endPrice;
  state.polymarket.winningOutcome = metadata.winningOutcome || state.polymarket.winningOutcome || "unknown";
  state.polymarket.metadataUpdatedTs = Date.now();
}

export function observePolymarketQuote({ marketId, side, bid, ask, lastTradePrice, eventTs }) {
  ensureCurrentMarket();
  if (marketId && state.market?.id !== marketId) return;
  if (!["up", "down"].includes(side)) return;

  const target = state.polymarket[side];
  const nextBid = readNumber(bid);
  const nextAsk = readNumber(ask);
  const nextTrade = readNumber(lastTradePrice);
  const receivedTs = Date.now();

  if (nextBid !== null) target.bid = nextBid;
  if (nextAsk !== null) target.ask = nextAsk;
  if (nextTrade !== null) target.lastTradePrice = nextTrade;
  if (target.bid !== null && target.ask !== null) {
    target.mid = (target.bid + target.ask) / 2;
  }
  target.eventTs = readNumber(eventTs) || receivedTs;
  target.receivedTs = receivedTs;

  updatePolymarketPairQuality();
}

function trimWebsocketBtcPriceHistory(nowMs = Date.now()) {
  const cutoffMs = nowMs - WEBSOCKET_BTC_PRICE_HISTORY_MS;
  while (
    state.websocketBtcPriceHistory.length > 0 &&
    state.websocketBtcPriceHistory[0].receivedAtMs < cutoffMs
  ) {
    state.websocketBtcPriceHistory.shift();
  }
}

function recordWebsocketBtcPrice({ source, eventTimeMs, receivedAtMs, price }) {
  if (!source || !Number.isFinite(eventTimeMs) || !Number.isFinite(receivedAtMs)) return;
  if (!Number.isFinite(price) || price <= 0) return;

  state.websocketBtcPriceHistory.push({
    source,
    eventTimeMs,
    receivedAtMs,
    price,
  });
  trimWebsocketBtcPriceHistory(receivedAtMs);
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

export function getWebsocketBtcPriceCsv(windowMs = WEBSOCKET_BTC_PRICE_HISTORY_MS) {
  const nowMs = Date.now();
  const safeWindowMs = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0
    ? Math.min(Number(windowMs), WEBSOCKET_BTC_PRICE_HISTORY_MS)
    : WEBSOCKET_BTC_PRICE_HISTORY_MS;
  const cutoffMs = nowMs - safeWindowMs;
  trimWebsocketBtcPriceHistory(nowMs);

  const events = state.websocketBtcPriceHistory
    .filter((row) => row.receivedAtMs >= cutoffMs && row.receivedAtMs <= nowMs)
    .sort((left, right) => left.receivedAtMs - right.receivedAtMs);

  const columns = ["timestamp_utc", "binance_btc_price", "chainlink_btc_price"];
  const rows = [];
  if (events.length > 0) {
    let eventIndex = 0;
    let latestBinancePrice = null;
    let latestChainlinkPrice = null;
    const firstSecondMs = Math.max(Math.ceil(cutoffMs / 1000) * 1000, Math.floor(events[0].receivedAtMs / 1000) * 1000);
    const lastSecondMs = Math.floor(nowMs / 1000) * 1000;

    for (let secondMs = firstSecondMs; secondMs <= lastSecondMs; secondMs += 1000) {
      const secondEndMs = secondMs + 999;
      while (eventIndex < events.length && events[eventIndex].receivedAtMs <= secondEndMs) {
        const event = events[eventIndex];
        if (event.source === "binance_futures_book_ticker_mid") {
          latestBinancePrice = event.price;
        } else if (event.source === "polymarket_rtds_chainlink_btc") {
          latestChainlinkPrice = event.price;
        }
        eventIndex += 1;
      }

      rows.push({
        timestamp_utc: toIso(secondMs),
        binance_btc_price: latestBinancePrice,
        chainlink_btc_price: latestChainlinkPrice,
      });
    }
  }

  const lines = [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

export function observeChainlinkTick(tick) {
  ensureCurrentMarket();
  const nowMs = Date.now();
  const price = readPositiveNumber(tick?.price);
  if (price === null) return;

  const exchangeMs = readNumber(tick.priceTimestampMs) || readNumber(tick.exchangeTs) || null;
  const serverMs = readNumber(tick.serverTimestampMs) || null;
  const receivedMs = readNumber(tick.receivedAtMs) || nowMs;
  const ageMs = exchangeMs ? Math.max(0, nowMs - exchangeMs) : Math.max(0, nowMs - receivedMs);

  state.chainlink = {
    price,
    exchangeTs: exchangeMs,
    serverTs: serverMs,
    receivedTs: receivedMs,
    ageMs,
    quality: qualityFromAge(ageMs, POLYMARKET_RTDS_STALE_MS),
  };
  recordWebsocketBtcPrice({
    source: "polymarket_rtds_chainlink_btc",
    eventTimeMs: exchangeMs || serverMs || receivedMs,
    receivedAtMs: receivedMs,
    price,
  });
  maybeSetOpeningPriceToBeat(price, exchangeMs || receivedMs);
}

export function observeBinanceBookTicker(data) {
  ensureCurrentMarket();
  const nowMs = Date.now();
  const bestBid = readPositiveNumber(data?.b);
  const bestBidQty = readNumber(data?.B);
  const bestAsk = readPositiveNumber(data?.a);
  const bestAskQty = readNumber(data?.A);
  if (bestBid === null || bestAsk === null || bestAsk < bestBid) return;

  const eventTs = readNumber(data?.E) || readNumber(data?.T) || nowMs;
  rollBuckets(nowMs);
  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10000 : null;
  const microprice = bestBidQty !== null && bestAskQty !== null && bestBidQty + bestAskQty > 0
    ? (bestAsk * bestBidQty + bestBid * bestAskQty) / (bestBidQty + bestAskQty)
    : null;
  const micropriceLean = calculateMicropriceLean(mid, microprice, spreadBps);
  const bookImbalance = calculateBookImbalance(bestBidQty, bestAskQty);

  state.binance.bestBid = bestBid;
  state.binance.bestBidQty = bestBidQty;
  state.binance.bestAsk = bestAsk;
  state.binance.bestAskQty = bestAskQty;
  state.binance.mid = mid;
  state.binance.spreadBps = spreadBps;
  state.binance.microprice = microprice;
  state.binance.micropriceLean = micropriceLean;
  state.binance.bookImbalance = bookImbalance;
  state.binance.bookEventTs = eventTs;
  state.binance.bookReceivedTs = nowMs;
  state.binance.eventLagMs = Math.max(0, nowMs - eventTs);
  recordWebsocketBtcPrice({
    source: "binance_futures_book_ticker_mid",
    eventTimeMs: eventTs,
    receivedAtMs: nowMs,
    price: mid,
  });

  if (micropriceLean !== null) {
    state.currentBucket.micropriceLean = micropriceLean;
    state.currentBucket.micropriceSampleCount += 1;
  }
}

export function observeBinanceAggTrade(data) {
  const price = readPositiveNumber(data?.p);
  const quantity = readPositiveNumber(data?.q);
  if (price === null || quantity === null) return;

  const eventTs = readNumber(data?.T) || readNumber(data?.E) || Date.now();
  rollBuckets(eventTs);
  const quote = price * quantity;
  const buyerIsMaker = data?.m === true;
  const isTakerBuy = !buyerIsMaker;

  if (isTakerBuy) {
    state.currentBucket.takerBuyQuote += quote;
    state.marketFlow.takerBuyQuote += quote;
  } else {
    state.currentBucket.takerSellQuote += quote;
    state.marketFlow.takerSellQuote += quote;
  }

  state.currentBucket.netTakerQuote = state.currentBucket.takerBuyQuote - state.currentBucket.takerSellQuote;
  state.currentBucket.grossTakerQuote = state.currentBucket.takerBuyQuote + state.currentBucket.takerSellQuote;
  state.currentBucket.tradeCount += 1;

  state.marketFlow.netTakerQuote = state.marketFlow.takerBuyQuote - state.marketFlow.takerSellQuote;
  state.marketFlow.grossTakerQuote = state.marketFlow.takerBuyQuote + state.marketFlow.takerSellQuote;
  state.marketFlow.tradeCount += 1;
  state.continuousCvdQuote += isTakerBuy ? quote : -quote;
}

export function observeBinanceForceOrder(data) {
  const order = data?.o || {};
  const price = readPositiveNumber(order.ap || order.p);
  const quantity = readPositiveNumber(order.z || order.q);
  const side = String(order.S || "").toUpperCase();
  if (price === null || quantity === null || !["BUY", "SELL"].includes(side)) return;

  const eventTs = readNumber(order.T) || readNumber(data?.E) || Date.now();
  rollBuckets(eventTs);
  const quote = price * quantity;

  if (side === "BUY") {
    state.currentBucket.liquidationBuyQuote += quote;
    state.marketFlow.liquidationBuyQuote += quote;
  } else {
    state.currentBucket.liquidationSellQuote += quote;
    state.marketFlow.liquidationSellQuote += quote;
  }

  state.currentBucket.liquidationNetQuote = state.currentBucket.liquidationBuyQuote - state.currentBucket.liquidationSellQuote;
  state.currentBucket.liquidationCount += 1;
  state.marketFlow.liquidationNetQuote = state.marketFlow.liquidationBuyQuote - state.marketFlow.liquidationSellQuote;
  state.marketFlow.liquidationCount += 1;
}

function addPositionHistoryPoint(point) {
  state.positionHistory.push(point);
  const cutoff = point.receivedTs - MAX_POSITION_HISTORY_MS;
  state.positionHistory = state.positionHistory.filter((row) => row.receivedTs >= cutoff && row.receivedTs <= point.receivedTs);
}

function calculateRollingOpenInterestChange(receivedTs, openInterestBase, openInterestQuote) {
  const cutoff = receivedTs - POSITION_ROLLING_WINDOW_MS;
  let reference = null;
  for (const row of state.positionHistory) {
    if (row.receivedTs <= cutoff) {
      reference = row;
    } else {
      break;
    }
  }
  if (!reference) reference = state.positionHistory[0] || null;
  if (!reference) {
    return {
      openInterestChange1mBase: null,
      openInterestChange1mQuote: null,
      openInterestChange1mPct: null,
      openInterestRollingWindowMs: null,
    };
  }

  const openInterestChange1mBase = openInterestBase - reference.openInterestBase;
  const openInterestChange1mQuote = openInterestQuote - reference.openInterestQuote;
  const openInterestChange1mPct = reference.openInterestQuote > 0
    ? (openInterestChange1mQuote / reference.openInterestQuote) * 100
    : null;

  return {
    openInterestChange1mBase,
    openInterestChange1mQuote,
    openInterestChange1mPct,
    openInterestRollingWindowMs: Math.max(0, receivedTs - reference.receivedTs),
  };
}

export function observeFuturesPositionTick(sample) {
  ensureCurrentMarket();
  const nowMs = Date.now();
  const receivedTs = readNumber(sample?.receivedTs) || nowMs;
  const openInterestBase = readNumber(sample?.openInterestBase);
  const markPrice = readPositiveNumber(sample?.markPrice);
  if (openInterestBase === null || openInterestBase < 0 || markPrice === null) return;

  const openInterestQuote = readNumber(sample?.openInterestQuote) ?? openInterestBase * markPrice;
  const indexPrice = readPositiveNumber(sample?.indexPrice);
  const openInterestOpenBase = state.position.openInterestOpenBase ?? openInterestBase;
  const openInterestOpenQuote = state.position.openInterestOpenQuote ?? openInterestQuote;
  const openInterestChangeBase = openInterestBase - openInterestOpenBase;
  const openInterestChangeQuote = openInterestQuote - openInterestOpenQuote;
  const openInterestChangePct = openInterestOpenQuote > 0
    ? (openInterestChangeQuote / openInterestOpenQuote) * 100
    : null;

  addPositionHistoryPoint({ receivedTs, openInterestBase, openInterestQuote });
  const rolling = calculateRollingOpenInterestChange(receivedTs, openInterestBase, openInterestQuote);

  state.position = {
    openInterestBase,
    openInterestQuote,
    openInterestOpenBase,
    openInterestOpenQuote,
    openInterestChangeBase,
    openInterestChangeQuote,
    openInterestChangePct,
    openInterestChange1mBase: rolling.openInterestChange1mBase,
    openInterestChange1mQuote: rolling.openInterestChange1mQuote,
    openInterestChange1mPct: rolling.openInterestChange1mPct,
    openInterestRollingWindowMs: rolling.openInterestRollingWindowMs,
    markPrice,
    indexPrice,
    premiumBps: readNumber(sample?.premiumBps),
    fundingRate: readNumber(sample?.fundingRate),
    nextFundingTime: readNumber(sample?.nextFundingTime),
    markExchangeTs: readNumber(sample?.markExchangeTs),
    openInterestExchangeTs: readNumber(sample?.openInterestExchangeTs),
    receivedTs,
    latencyMs: readNumber(sample?.latencyMs),
  };
}
export function observeBinanceMarkPrice(data) {
  ensureCurrentMarket();
  const nowMs = Date.now();
  const markPrice = readPositiveNumber(data?.p);
  const indexPrice = readPositiveNumber(data?.i);
  const fundingRate = readNumber(data?.r);
  const eventTs = readNumber(data?.E) || nowMs;
  if (markPrice === null && indexPrice === null && fundingRate === null) return;

  state.binance.markPrice = markPrice;
  state.binance.indexPrice = indexPrice;
  state.binance.fundingRate = fundingRate;
  state.binance.nextFundingTime = readNumber(data?.T);
  state.binance.markEventTs = eventTs;
  state.binance.markReceivedTs = nowMs;
}

function getStaleSources(nowMs) {
  const stale = [];
  const bookAge = state.binance.bookReceivedTs ? nowMs - state.binance.bookReceivedTs : null;
  const markAge = state.binance.markReceivedTs ? nowMs - state.binance.markReceivedTs : null;
  const chainlinkAge = state.chainlink.receivedTs ? nowMs - state.chainlink.receivedTs : null;
  const upAge = state.polymarket.up.receivedTs ? nowMs - state.polymarket.up.receivedTs : null;
  const downAge = state.polymarket.down.receivedTs ? nowMs - state.polymarket.down.receivedTs : null;
  const positionAge = state.position.receivedTs ? nowMs - state.position.receivedTs : null;

  if (bookAge === null || bookAge > BINANCE_STALE_MS) stale.push("binance_bookTicker");
  if (markAge === null || markAge > BINANCE_STALE_MS * 3) stale.push("binance_markPrice");
  if (chainlinkAge === null || chainlinkAge > POLYMARKET_RTDS_STALE_MS) stale.push("chainlink_rtds");
  if (upAge === null || upAge > POLYMARKET_STALE_MS) stale.push("polymarket_up");
  if (downAge === null || downAge > POLYMARKET_STALE_MS) stale.push("polymarket_down");
  if (positionAge === null || positionAge > POSITION_STALE_MS) stale.push("binance_openInterest");

  return stale;
}

export function getPublicLiveSnapshot() {
  const nowMs = Date.now();
  rollBuckets(nowMs);
  const market = ensureCurrentMarket(nowMs);
  const elapsedMs = Math.min(Math.max(nowMs - market.startMs, 0), MARKET_MS);
  const rolling = rollingFlow(nowMs);
  const micropricePressure = liveMicropricePressure(nowMs);
  const staleSources = getStaleSources(nowMs);
  state.collector.staleSources = staleSources;

  const bookAgeMs = state.binance.bookReceivedTs ? Math.max(0, nowMs - state.binance.bookReceivedTs) : null;
  const markAgeMs = state.binance.markReceivedTs ? Math.max(0, nowMs - state.binance.markReceivedTs) : null;
  const positionAgeMs = state.position.receivedTs ? Math.max(0, nowMs - state.position.receivedTs) : null;
  const up = sideSnapshot(state.polymarket.up, nowMs);
  const down = sideSnapshot(state.polymarket.down, nowMs);
  const chainlinkAgeMs = state.chainlink.exchangeTs
    ? Math.max(0, nowMs - state.chainlink.exchangeTs)
    : state.chainlink.receivedTs
      ? Math.max(0, nowMs - state.chainlink.receivedTs)
      : null;

  return {
    market: {
      id: market.id,
      symbol: market.symbol,
      slug: state.polymarket.slug || slugForMarket(market),
      startTime: market.start.toISOString(),
      endTime: market.end.toISOString(),
      secondsElapsed: Math.floor(elapsedMs / 1000),
      secondsRemaining: Math.max(0, Math.ceil((market.endMs - nowMs) / 1000)),
      status: nowMs < market.endMs ? "open" : "closing",
    },
    polymarket: {
      slug: state.polymarket.slug,
      conditionId: state.polymarket.conditionId,
      upTokenId: state.polymarket.upTokenId,
      downTokenId: state.polymarket.downTokenId,
      priceToBeat: state.polymarket.priceToBeat,
      endPrice: state.polymarket.endPrice,
      winningOutcome: state.polymarket.winningOutcome,
      priceToBeatSource: state.polymarket.priceToBeatSource,
      up,
      down,
      normalizedUp: state.polymarket.normalizedUp,
      normalizedDown: state.polymarket.normalizedDown,
      probabilitySum: state.polymarket.probabilitySum,
      quality: state.polymarket.quality,
    },
    chainlink: {
      price: state.chainlink.price,
      exchangeTs: toIso(state.chainlink.exchangeTs),
      serverTs: toIso(state.chainlink.serverTs),
      receivedTs: toIso(state.chainlink.receivedTs),
      ageMs: chainlinkAgeMs,
      quality: qualityFromAge(chainlinkAgeMs, POLYMARKET_RTDS_STALE_MS),
    },
    binance: {
      bestBid: state.binance.bestBid,
      bestBidQty: state.binance.bestBidQty,
      bestAsk: state.binance.bestAsk,
      bestAskQty: state.binance.bestAskQty,
      mid: state.binance.mid,
      spreadBps: state.binance.spreadBps,
      microprice: state.binance.microprice,
      micropriceLean: micropricePressure.micropriceLean,
      bookImbalance: state.binance.bookImbalance,
      micropricePressureDelta1s: micropricePressure.micropricePressureDelta1s,
      micropricePressureMarket: micropricePressure.micropricePressureMarket,
      micropricePressureContinuous: micropricePressure.micropricePressureContinuous,
      micropriceSampleCount1s: micropricePressure.micropriceSampleCount1s,
      markPrice: state.binance.markPrice,
      indexPrice: state.binance.indexPrice,
      fundingRate: state.binance.fundingRate,
      nextFundingTime: toIso(state.binance.nextFundingTime),
      eventLagMs: state.binance.eventLagMs,
      bookAgeMs,
      markAgeMs,
      quality: qualityFromAge(bookAgeMs, BINANCE_STALE_MS),
    },
    position: {
      openInterestBase: state.position.openInterestBase,
      openInterestQuote: state.position.openInterestQuote,
      openInterestOpenBase: state.position.openInterestOpenBase,
      openInterestOpenQuote: state.position.openInterestOpenQuote,
      openInterestChangeBase: state.position.openInterestChangeBase,
      openInterestChangeQuote: state.position.openInterestChangeQuote,
      openInterestChangePct: state.position.openInterestChangePct,
      openInterestChange1mBase: state.position.openInterestChange1mBase,
      openInterestChange1mQuote: state.position.openInterestChange1mQuote,
      openInterestChange1mPct: state.position.openInterestChange1mPct,
      openInterestRollingWindowMs: state.position.openInterestRollingWindowMs,
      markPrice: state.position.markPrice,
      indexPrice: state.position.indexPrice,
      premiumBps: state.position.premiumBps,
      fundingRate: state.position.fundingRate,
      nextFundingTime: toIso(state.position.nextFundingTime),
      markExchangeTs: toIso(state.position.markExchangeTs),
      openInterestExchangeTs: toIso(state.position.openInterestExchangeTs),
      receivedTs: toIso(state.position.receivedTs),
      latencyMs: state.position.latencyMs,
      ageMs: positionAgeMs,
      quality: qualityFromAge(positionAgeMs, POSITION_STALE_MS),
    },
    flow: {
      takerBuyQuote1s: state.currentBucket.takerBuyQuote,
      takerSellQuote1s: state.currentBucket.takerSellQuote,
      netTakerQuote1s: state.currentBucket.netTakerQuote,
      grossTakerQuote1s: state.currentBucket.grossTakerQuote,
      tradeCount1s: state.currentBucket.tradeCount,
      cvdMarketQuote: state.marketFlow.netTakerQuote,
      cvdContinuousQuote: state.continuousCvdQuote,
      rollingNet30s: rolling.rollingNet30s,
      rollingGross30s: rolling.rollingGross30s,
      rollingImbalance30s: rolling.rollingImbalance30s,
      marketTakerBuyQuote: state.marketFlow.takerBuyQuote,
      marketTakerSellQuote: state.marketFlow.takerSellQuote,
      marketGrossTakerQuote: state.marketFlow.grossTakerQuote,
      marketTradeCount: state.marketFlow.tradeCount,
    },
    liquidations: {
      buyQuote1s: state.currentBucket.liquidationBuyQuote,
      sellQuote1s: state.currentBucket.liquidationSellQuote,
      netQuote1s: state.currentBucket.liquidationNetQuote,
      count1s: state.currentBucket.liquidationCount,
      marketBuyQuote: state.marketFlow.liquidationBuyQuote,
      marketSellQuote: state.marketFlow.liquidationSellQuote,
      marketNetQuote: state.marketFlow.liquidationNetQuote,
      marketCount: state.marketFlow.liquidationCount,
    },
    collector: {
      snapshotTs: new Date(nowMs).toISOString(),
      uptimeSeconds: Math.floor((nowMs - state.collector.startedAt) / 1000),
      eventLoopLagMs: state.collector.eventLoopLagMs,
      reconnectCount: state.collector.reconnectCount,
      staleSources,
      lastPersistedAt: toIso(state.collector.lastPersistedAt),
      persistError: state.collector.persistError,
    },
  };
}

async function persistLiveSnapshot() {
  const snapshot = getPublicLiveSnapshot();
  await query(
    `
      insert into live_state (key, updated_at, market_id, payload)
      values ($1, now(), $2, $3::jsonb)
      on conflict (key) do update set
        updated_at = excluded.updated_at,
        market_id = excluded.market_id,
        payload = excluded.payload
    `,
    ["latest", snapshot.market.id, JSON.stringify(snapshot)]
  );
  state.collector.lastPersistedAt = Date.now();
  state.collector.persistError = null;
}

export function startLiveStateFlusher() {
  if (state.flusher) return { stop: stopLiveStateFlusher };

  let lagStartedAt = performance.now();
  state.lagTimer = setInterval(() => {
    const now = performance.now();
    state.collector.eventLoopLagMs = Math.max(0, Math.round(now - lagStartedAt - 1000));
    lagStartedAt = now;
  }, 1000);
  state.lagTimer.unref?.();

  state.flusher = setInterval(() => {
    persistLiveSnapshot().catch((error) => {
      state.collector.persistError = error.message || String(error);
    });
  }, LIVE_STATE_PERSIST_INTERVAL_MS);
  state.flusher.unref?.();

  persistLiveSnapshot().catch((error) => {
    state.collector.persistError = error.message || String(error);
  });

  return { stop: stopLiveStateFlusher };
}

export function stopLiveStateFlusher() {
  if (state.flusher) {
    clearInterval(state.flusher);
    state.flusher = null;
  }
  if (state.lagTimer) {
    clearInterval(state.lagTimer);
    state.lagTimer = null;
  }
}
