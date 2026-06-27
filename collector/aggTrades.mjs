import { query } from "../lib/db.js";
import {
  AGG_TRADE_PAGE_LIMIT,
  FUTURES_MICROSTRUCTURE_SOURCE,
  MAX_AGG_TRADE_PAGES_PER_MARKET,
  REQUEST_TIMEOUT_MS,
} from "./config.mjs";
import { fetchJson } from "./http.mjs";
import { recordError } from "./store.mjs";

const INSERT_CHUNK_SIZE = 500;

function parseAggTrade(rawTrade) {
  const aggTradeId = Number(rawTrade.a);
  const price = Number(rawTrade.p);
  const quantity = Number(rawTrade.q);
  const tradeTimeMs = Number(rawTrade.T);
  const buyerIsMaker = Boolean(rawTrade.m);

  if (
    !Number.isFinite(aggTradeId) ||
    !Number.isFinite(price) ||
    !Number.isFinite(quantity) ||
    !Number.isFinite(tradeTimeMs) ||
    price <= 0 ||
    quantity < 0
  ) {
    return null;
  }

  return {
    aggTradeId,
    eventTime: rawTrade.E ? new Date(Number(rawTrade.E)) : null,
    tradeTime: new Date(tradeTimeMs),
    tradeTimeMs,
    price,
    quantity,
    quoteNotional: price * quantity,
    buyerIsMaker,
    takerSide: buyerIsMaker ? "sell" : "buy",
    firstTradeId: rawTrade.f === undefined ? null : Number(rawTrade.f),
    lastTradeId: rawTrade.l === undefined ? null : Number(rawTrade.l),
  };
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function insertAggTrades(market, trades) {
  if (trades.length === 0) return;

  const source = FUTURES_MICROSTRUCTURE_SOURCE;

  for (const tradeChunk of chunk(trades, INSERT_CHUNK_SIZE)) {
    const values = [];
    const placeholders = tradeChunk.map((trade, index) => {
      const offset = index * 13;
      values.push(
        source.source,
        source.instrumentType,
        market.symbol,
        trade.aggTradeId,
        trade.eventTime,
        trade.tradeTime,
        trade.price,
        trade.quantity,
        trade.quoteNotional,
        trade.buyerIsMaker,
        trade.takerSide,
        trade.firstTradeId,
        trade.lastTradeId
      );
      return `(${Array.from({ length: 13 }, (_, column) => `$${offset + column + 1}`).join(", ")})`;
    });

    await query(
      `
        insert into agg_trades
          (
            source,
            instrument_type,
            symbol,
            agg_trade_id,
            event_time,
            trade_time,
            price,
            quantity,
            quote_notional,
            buyer_is_maker,
            taker_side,
            first_trade_id,
            last_trade_id
          )
        values ${placeholders.join(", ")}
        on conflict (source, symbol, agg_trade_id) do update set
          event_time = excluded.event_time,
          trade_time = excluded.trade_time,
          price = excluded.price,
          quantity = excluded.quantity,
          quote_notional = excluded.quote_notional,
          buyer_is_maker = excluded.buyer_is_maker,
          taker_side = excluded.taker_side,
          first_trade_id = excluded.first_trade_id,
          last_trade_id = excluded.last_trade_id,
          collected_at = now()
      `,
      values
    );
  }
}

function parseAggTradePage(data, market) {
  if (!Array.isArray(data)) {
    throw new Error("Aggregate trade payload was not an array");
  }

  return data
    .map(parseAggTrade)
    .filter(
      (trade) => trade && trade.tradeTimeMs >= market.startMs && trade.tradeTimeMs < market.endMs
    );
}

export async function collectFuturesAggregateTradesForMarket(market) {
  const source = FUTURES_MICROSTRUCTURE_SOURCE;
  const endTime = market.endMs - 1;
  let fromId = null;
  let pageCount = 0;
  let storedCount = 0;
  let reachedEnd = false;

  try {
    while (pageCount < MAX_AGG_TRADE_PAGES_PER_MARKET && !reachedEnd) {
      const url =
        fromId === null
          ? source.aggTradesUrl({
              startTime: market.startMs,
              endTime,
              limit: AGG_TRADE_PAGE_LIMIT,
            })
          : source.aggTradesUrl({
              fromId,
              limit: AGG_TRADE_PAGE_LIMIT,
            });

      const { data } = await fetchJson(url, REQUEST_TIMEOUT_MS);
      if (!Array.isArray(data) || data.length === 0) break;

      const parsedTrades = parseAggTradePage(data, market);
      await insertAggTrades(market, parsedTrades);
      storedCount += parsedTrades.length;

      const lastRawTrade = data[data.length - 1];
      const lastTradeId = Number(lastRawTrade.a);
      const lastTradeTimeMs = Number(lastRawTrade.T);

      if (!Number.isFinite(lastTradeId) || !Number.isFinite(lastTradeTimeMs)) {
        throw new Error("Aggregate trade page had an invalid cursor");
      }

      reachedEnd = lastTradeTimeMs >= endTime || data.length < AGG_TRADE_PAGE_LIMIT;
      fromId = lastTradeId + 1;
      pageCount += 1;
    }

    if (!reachedEnd && pageCount >= MAX_AGG_TRADE_PAGES_PER_MARKET) {
      await recordError({
        marketId: market.id,
        source: source.source,
        errorType: "agg_trade_page_limit",
        message: `Stopped after ${pageCount} aggregate trade pages for ${market.id}`,
      });
    }

    return {
      ok: true,
      source: source.source,
      storedCount,
      pageCount,
      truncated: !reachedEnd && pageCount >= MAX_AGG_TRADE_PAGES_PER_MARKET,
    };
  } catch (error) {
    await recordError({
      marketId: market.id,
      source: source.source,
      errorType: error.name === "AbortError" ? "timeout" : "agg_trade_fetch_error",
      message: error.message || String(error),
    });
    return { ok: false, source: source.source, storedCount, pageCount, error };
  }
}
