import { query } from "../lib/db.js";
import {
  BASIS_SAMPLE_PERIOD,
  FUTURES_BASIS_CONTRACT_TYPE,
  FUTURES_MICROSTRUCTURE_SOURCE,
  MARKET_MS,
  REQUEST_TIMEOUT_MS,
} from "./config.mjs";
import { fetchJson } from "./http.mjs";
import { recordError } from "./store.mjs";

function readNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readRequiredNumber(value, fieldName) {
  const number = readNumber(value);
  if (number === null) {
    throw new Error(`Invalid ${fieldName} in futures basis payload`);
  }
  return number;
}

function toDateFromMilliseconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error("Invalid timestamp in futures basis payload");
  }
  return new Date(number);
}

function parseBasisSample(row) {
  const indexPrice = readRequiredNumber(row.indexPrice, "indexPrice");
  const futuresPrice = readRequiredNumber(row.futuresPrice, "futuresPrice");
  const basis = readRequiredNumber(row.basis, "basis");
  const basisRate = readRequiredNumber(row.basisRate, "basisRate");
  const rawTimestampMs = readRequiredNumber(row.timestamp, "timestamp");

  return {
    basisTime: toDateFromMilliseconds(rawTimestampMs),
    pair: row.pair || null,
    contractType: row.contractType || null,
    indexPrice,
    futuresPrice,
    basis,
    basisRate,
    basisBps: basisRate * 10000,
    rawTimestampMs: Math.trunc(rawTimestampMs),
  };
}

async function insertBasisSample(market, sample, latencyMs) {
  const source = FUTURES_MICROSTRUCTURE_SOURCE;

  await query(
    `
      insert into futures_basis_samples
        (
          basis_time,
          collected_at,
          source,
          instrument_type,
          symbol,
          pair,
          contract_type,
          period,
          index_price,
          futures_price,
          basis,
          basis_rate,
          basis_bps,
          raw_timestamp_ms,
          basis_latency_ms
        )
      values ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      on conflict (basis_time, source, pair, contract_type, period) do update set
        collected_at = excluded.collected_at,
        symbol = excluded.symbol,
        index_price = excluded.index_price,
        futures_price = excluded.futures_price,
        basis = excluded.basis,
        basis_rate = excluded.basis_rate,
        basis_bps = excluded.basis_bps,
        raw_timestamp_ms = excluded.raw_timestamp_ms,
        basis_latency_ms = excluded.basis_latency_ms
    `,
    [
      sample.basisTime,
      source.source,
      source.instrumentType,
      market.symbol,
      sample.pair || market.symbol,
      sample.contractType || FUTURES_BASIS_CONTRACT_TYPE,
      BASIS_SAMPLE_PERIOD,
      sample.indexPrice,
      sample.futuresPrice,
      sample.basis,
      sample.basisRate,
      sample.basisBps,
      sample.rawTimestampMs,
      latencyMs,
    ]
  );
}

export async function collectFuturesBasisSamplesForMarket(market) {
  const source = FUTURES_MICROSTRUCTURE_SOURCE;
  const startTime = market.startMs - MARKET_MS;
  const endTime = market.endMs + MARKET_MS;

  try {
    const result = await fetchJson(
      source.basisUrl({ startTime, endTime, limit: 10 }),
      REQUEST_TIMEOUT_MS
    );
    const rows = Array.isArray(result.data) ? result.data : [];
    const samples = rows.map(parseBasisSample).filter((sample) => {
      const time = sample.basisTime.getTime();
      return time >= startTime && time <= endTime;
    });

    for (const sample of samples) {
      await insertBasisSample(market, sample, result.latencyMs);
    }

    return { ok: true, source: source.source, sampleCount: samples.length };
  } catch (error) {
    await recordError({
      marketId: market.id,
      source: source.source,
      errorType: error.name === "AbortError" ? "timeout" : "basis_fetch_error",
      message: error.message || String(error),
    });
    return { ok: false, source: source.source, error, sampleCount: 0 };
  }
}
