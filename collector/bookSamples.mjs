import { query } from "../lib/db.js";
import {
  FUTURES_MICROSTRUCTURE_SOURCE,
  REQUEST_TIMEOUT_MS,
} from "./config.mjs";
import { fetchJson } from "./http.mjs";
import { recordError } from "./store.mjs";

function toDateFromMilliseconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return new Date(number);
}

function parseLevels(levels, side) {
  if (!Array.isArray(levels) || levels.length === 0) {
    throw new Error(`Depth payload has no ${side} levels`);
  }

  return levels
    .map(([priceValue, quantityValue]) => {
      const price = Number(priceValue);
      const quantity = Number(quantityValue);
      return {
        price,
        quantity,
        notional: price * quantity,
      };
    })
    .filter(
      (level) =>
        Number.isFinite(level.price) &&
        Number.isFinite(level.quantity) &&
        level.price > 0 &&
        level.quantity >= 0
    );
}

function sumDepth(levels, predicate) {
  return levels.reduce((total, level) => {
    if (!predicate(level)) return total;
    return total + level.notional;
  }, 0);
}

function imbalance(bidDepth, askDepth) {
  const total = bidDepth + askDepth;
  return total > 0 ? (bidDepth - askDepth) / total : null;
}

function deriveBookSample(data) {
  const bids = parseLevels(data.bids, "bid");
  const asks = parseLevels(data.asks, "ask");
  const bestBid = bids[0];
  const bestAsk = asks[0];

  if (!bestBid || !bestAsk || bestBid.price <= 0 || bestAsk.price <= 0) {
    throw new Error("Depth payload has invalid top of book");
  }

  const midPrice = (bestBid.price + bestAsk.price) / 2;
  const spreadBps = ((bestAsk.price - bestBid.price) / midPrice) * 10000;
  const bidDepth5 = sumDepth(bids, (level) => level.price >= midPrice * (1 - 0.0005));
  const askDepth5 = sumDepth(asks, (level) => level.price <= midPrice * (1 + 0.0005));
  const bidDepth10 = sumDepth(bids, (level) => level.price >= midPrice * (1 - 0.001));
  const askDepth10 = sumDepth(asks, (level) => level.price <= midPrice * (1 + 0.001));
  const bidDepth25 = sumDepth(bids, (level) => level.price >= midPrice * (1 - 0.0025));
  const askDepth25 = sumDepth(asks, (level) => level.price <= midPrice * (1 + 0.0025));

  return {
    lastUpdateId: data.lastUpdateId ? Number(data.lastUpdateId) : null,
    exchangeTime: toDateFromMilliseconds(data.E || data.T),
    bestBidPrice: bestBid.price,
    bestBidQty: bestBid.quantity,
    bestAskPrice: bestAsk.price,
    bestAskQty: bestAsk.quantity,
    midPrice,
    spreadBps,
    bidDepth5,
    askDepth5,
    bookImbalance5: imbalance(bidDepth5, askDepth5),
    bidDepth10,
    askDepth10,
    bookImbalance10: imbalance(bidDepth10, askDepth10),
    bidDepth25,
    askDepth25,
    bookImbalance25: imbalance(bidDepth25, askDepth25),
  };
}

async function insertBookSample(market, scheduledAt, sampleType, sample, latencyMs) {
  const source = FUTURES_MICROSTRUCTURE_SOURCE;

  await query(
    `
      insert into book_samples
        (
          scheduled_at,
          collected_at,
          source,
          instrument_type,
          symbol,
          sample_type,
          last_update_id,
          exchange_time,
          best_bid_price,
          best_bid_qty,
          best_ask_price,
          best_ask_qty,
          mid_price,
          spread_bps,
          bid_depth_5bps,
          ask_depth_5bps,
          book_imbalance_5bps,
          bid_depth_10bps,
          ask_depth_10bps,
          book_imbalance_10bps,
          bid_depth_25bps,
          ask_depth_25bps,
          book_imbalance_25bps,
          latency_ms
        )
      values (
        $1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
      )
      on conflict (scheduled_at, source, symbol) do update set
        collected_at = excluded.collected_at,
        sample_type = excluded.sample_type,
        last_update_id = excluded.last_update_id,
        exchange_time = excluded.exchange_time,
        best_bid_price = excluded.best_bid_price,
        best_bid_qty = excluded.best_bid_qty,
        best_ask_price = excluded.best_ask_price,
        best_ask_qty = excluded.best_ask_qty,
        mid_price = excluded.mid_price,
        spread_bps = excluded.spread_bps,
        bid_depth_5bps = excluded.bid_depth_5bps,
        ask_depth_5bps = excluded.ask_depth_5bps,
        book_imbalance_5bps = excluded.book_imbalance_5bps,
        bid_depth_10bps = excluded.bid_depth_10bps,
        ask_depth_10bps = excluded.ask_depth_10bps,
        book_imbalance_10bps = excluded.book_imbalance_10bps,
        bid_depth_25bps = excluded.bid_depth_25bps,
        ask_depth_25bps = excluded.ask_depth_25bps,
        book_imbalance_25bps = excluded.book_imbalance_25bps,
        latency_ms = excluded.latency_ms
    `,
    [
      scheduledAt,
      source.source,
      source.instrumentType,
      market.symbol,
      sampleType,
      sample.lastUpdateId,
      sample.exchangeTime,
      sample.bestBidPrice,
      sample.bestBidQty,
      sample.bestAskPrice,
      sample.bestAskQty,
      sample.midPrice,
      sample.spreadBps,
      sample.bidDepth5,
      sample.askDepth5,
      sample.bookImbalance5,
      sample.bidDepth10,
      sample.askDepth10,
      sample.bookImbalance10,
      sample.bidDepth25,
      sample.askDepth25,
      sample.bookImbalance25,
      latencyMs,
    ]
  );
}

export async function collectFuturesBookSample(market, scheduledAt, sampleType) {
  const source = FUTURES_MICROSTRUCTURE_SOURCE;

  try {
    const { data, latencyMs } = await fetchJson(source.depthUrl(), REQUEST_TIMEOUT_MS);
    const sample = deriveBookSample(data);
    await insertBookSample(market, scheduledAt, sampleType, sample, latencyMs);
    return { ok: true, source: source.source };
  } catch (error) {
    await recordError({
      marketId: market.id,
      source: source.source,
      errorType: error.name === "AbortError" ? "timeout" : "book_depth_fetch_error",
      message: error.message || String(error),
    });
    return { ok: false, source: source.source, error };
  }
}
