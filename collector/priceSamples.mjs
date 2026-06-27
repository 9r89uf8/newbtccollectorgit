import { query } from "../lib/db.js";
import { PRICE_SOURCES, REQUEST_TIMEOUT_MS } from "./config.mjs";
import { fetchJson } from "./http.mjs";
import { recordError } from "./store.mjs";

async function fetchPrice(sourceConfig) {
  const { data, latencyMs } = await fetchJson(sourceConfig.url(), REQUEST_TIMEOUT_MS);
  const parsed = sourceConfig.parse(data);
  const price = Number(parsed.price);

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid price payload from ${sourceConfig.source}`);
  }

  return {
    price,
    exchangeTime: parsed.exchangeTime,
    latencyMs,
  };
}

async function insertSample(sourceConfig, market, scheduledAt, sampleType, result) {
  await query(
    `
      insert into price_samples
        (
          scheduled_at,
          collected_at,
          source,
          instrument_type,
          symbol,
          price_type,
          price,
          exchange_time,
          latency_ms,
          sample_type
        )
      values ($1, now(), $2, $3, $4, 'last', $5, $6, $7, $8)
      on conflict (scheduled_at, source, symbol, sample_type) do update set
        collected_at = excluded.collected_at,
        price = excluded.price,
        exchange_time = excluded.exchange_time,
        latency_ms = excluded.latency_ms
    `,
    [
      scheduledAt,
      sourceConfig.source,
      sourceConfig.instrumentType,
      market.symbol,
      result.price,
      result.exchangeTime,
      result.latencyMs,
      sampleType,
    ]
  );
}

async function sampleSource(sourceConfig, market, scheduledAt, sampleType) {
  try {
    const result = await fetchPrice(sourceConfig);
    await insertSample(sourceConfig, market, scheduledAt, sampleType, result);
    return { ok: true, source: sourceConfig.source };
  } catch (error) {
    await recordError({
      marketId: market.id,
      source: sourceConfig.source,
      errorType: error.name === "AbortError" ? "timeout" : "fetch_error",
      message: error.message || String(error),
    });
    return { ok: false, source: sourceConfig.source, error };
  }
}

export async function collectPriceSamples(market, scheduledAt, sampleType) {
  const results = await Promise.all(
    PRICE_SOURCES.map((sourceConfig) => sampleSource(sourceConfig, market, scheduledAt, sampleType))
  );

  return {
    ok: results.every((result) => result.ok),
    results,
  };
}
