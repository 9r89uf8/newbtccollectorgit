import { query } from "../lib/db.js";
import {
  FUTURES_MICROSTRUCTURE_SOURCE,
  POSITION_SAMPLE_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
} from "./config.mjs";
import { fetchJson } from "./http.mjs";
import { recordError } from "./store.mjs";

function toDateFromMilliseconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return new Date(number);
}

function readNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readPositiveNumber(value, fieldName) {
  const number = readNumber(value);
  if (number === null || number <= 0) {
    throw new Error(`Invalid ${fieldName} in futures positioning payload`);
  }
  return number;
}

function readNonNegativeNumber(value, fieldName) {
  const number = readNumber(value);
  if (number === null || number < 0) {
    throw new Error(`Invalid ${fieldName} in futures positioning payload`);
  }
  return number;
}

function parsePositionSample(markData, openInterestData) {
  const markPrice = readPositiveNumber(markData.markPrice, "markPrice");
  const indexPrice = readPositiveNumber(markData.indexPrice, "indexPrice");
  const openInterestBase = readNonNegativeNumber(openInterestData.openInterest, "openInterest");

  return {
    markPrice,
    indexPrice,
    premiumBps: ((markPrice - indexPrice) / indexPrice) * 10000,
    fundingRate: readNumber(markData.lastFundingRate),
    interestRate: readNumber(markData.interestRate),
    nextFundingTime: toDateFromMilliseconds(markData.nextFundingTime),
    openInterestBase,
    openInterestQuote: openInterestBase * markPrice,
    markExchangeTime: toDateFromMilliseconds(markData.time),
    openInterestExchangeTime: toDateFromMilliseconds(openInterestData.time),
  };
}

export function shouldCollectFuturesPositionSample(market, scheduledAt) {
  const offsetMs = scheduledAt.getTime() - market.startMs;
  return offsetMs >= 0 && offsetMs <= market.endMs - market.startMs && offsetMs % POSITION_SAMPLE_INTERVAL_MS === 0;
}

async function insertPositionSample(market, scheduledAt, sampleType, sample, markLatencyMs, openInterestLatencyMs) {
  const source = FUTURES_MICROSTRUCTURE_SOURCE;

  await query(
    `
      insert into derivative_position_samples
        (
          scheduled_at,
          collected_at,
          source,
          instrument_type,
          symbol,
          sample_type,
          mark_price,
          index_price,
          premium_bps,
          funding_rate,
          interest_rate,
          next_funding_time,
          open_interest_base,
          open_interest_quote,
          mark_exchange_time,
          open_interest_exchange_time,
          mark_latency_ms,
          open_interest_latency_ms
        )
      values ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      on conflict (scheduled_at, source, symbol) do update set
        collected_at = excluded.collected_at,
        sample_type = excluded.sample_type,
        mark_price = excluded.mark_price,
        index_price = excluded.index_price,
        premium_bps = excluded.premium_bps,
        funding_rate = excluded.funding_rate,
        interest_rate = excluded.interest_rate,
        next_funding_time = excluded.next_funding_time,
        open_interest_base = excluded.open_interest_base,
        open_interest_quote = excluded.open_interest_quote,
        mark_exchange_time = excluded.mark_exchange_time,
        open_interest_exchange_time = excluded.open_interest_exchange_time,
        mark_latency_ms = excluded.mark_latency_ms,
        open_interest_latency_ms = excluded.open_interest_latency_ms
    `,
    [
      scheduledAt,
      source.source,
      source.instrumentType,
      market.symbol,
      sampleType,
      sample.markPrice,
      sample.indexPrice,
      sample.premiumBps,
      sample.fundingRate,
      sample.interestRate,
      sample.nextFundingTime,
      sample.openInterestBase,
      sample.openInterestQuote,
      sample.markExchangeTime,
      sample.openInterestExchangeTime,
      markLatencyMs,
      openInterestLatencyMs,
    ]
  );
}

export async function collectFuturesPositionSample(market, scheduledAt, sampleType) {
  const source = FUTURES_MICROSTRUCTURE_SOURCE;

  try {
    const [markResult, openInterestResult] = await Promise.all([
      fetchJson(source.markPriceUrl(), REQUEST_TIMEOUT_MS),
      fetchJson(source.openInterestUrl(), REQUEST_TIMEOUT_MS),
    ]);
    const sample = parsePositionSample(markResult.data, openInterestResult.data);
    await insertPositionSample(
      market,
      scheduledAt,
      sampleType,
      sample,
      markResult.latencyMs,
      openInterestResult.latencyMs
    );
    return { ok: true, source: source.source };
  } catch (error) {
    await recordError({
      marketId: market.id,
      source: source.source,
      errorType: error.name === "AbortError" ? "timeout" : "position_fetch_error",
      message: error.message || String(error),
    });
    return { ok: false, source: source.source, error };
  }
}
