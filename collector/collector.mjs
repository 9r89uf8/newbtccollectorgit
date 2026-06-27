import { performance } from "node:perf_hooks";
import { loadLocalEnv } from "../lib/env.js";

loadLocalEnv();
const { closePool, query } = await import("../lib/db.js");

const MARKET_MS = 5 * 60 * 1000;
const NORMAL_INTERVAL_MS = 5 * 1000;
const FINAL_RAMP_START_MS = 280 * 1000;
const FINAL_RAMP_INTERVAL_MS = 1000;
const MARKET_CLOSE_MS = 300 * 1000;
const EXPECTED_SAMPLES_PER_SOURCE = 77;

const COLLECTOR_NAME = process.env.COLLECTOR_NAME || "btc-price-collector";
const SYMBOL = process.env.COLLECTOR_SYMBOL || "BTCUSDT";
const REQUEST_TIMEOUT_MS = Number(process.env.BINANCE_TIMEOUT_MS || 4000);

const SOURCES = [
  {
    source: "binance_spot",
    instrumentType: "spot",
    url: () =>
      `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(SYMBOL)}`,
    parse: (data) => ({ price: data.price, exchangeTime: null }),
  },
  {
    source: "binance_futures",
    instrumentType: "futures",
    url: () =>
      `https://fapi.binance.com/fapi/v2/ticker/price?symbol=${encodeURIComponent(SYMBOL)}`,
    parse: (data) => ({
      price: data.price,
      exchangeTime: data.time ? new Date(Number(data.time)) : null,
    }),
  },
];

let stopping = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toIsoSeconds(date) {
  return date.toISOString().replace(".000Z", "Z");
}

function getMarketWindow(date = new Date()) {
  const startMs = Math.floor(date.getTime() / MARKET_MS) * MARKET_MS;
  const endMs = startMs + MARKET_MS;
  const start = new Date(startMs);
  const end = new Date(endMs);

  return {
    id: `${toIsoSeconds(start)}_${SYMBOL}`,
    symbol: SYMBOL,
    start,
    end,
    startMs,
    endMs,
  };
}

function getSampleType(scheduledMs, market) {
  const offset = scheduledMs - market.startMs;
  if (offset >= MARKET_CLOSE_MS) return "close";
  if (offset >= FINAL_RAMP_START_MS) return "final_ramp";
  return "normal";
}

function getNextScheduledMs(nowMs, market) {
  const elapsed = Math.max(0, nowMs - market.startMs);

  if (elapsed <= 275000) {
    return market.startMs + Math.ceil(elapsed / NORMAL_INTERVAL_MS) * NORMAL_INTERVAL_MS;
  }

  if (elapsed <= FINAL_RAMP_START_MS) {
    return market.startMs + FINAL_RAMP_START_MS;
  }

  if (elapsed <= MARKET_CLOSE_MS) {
    return (
      market.startMs +
      Math.ceil(elapsed / FINAL_RAMP_INTERVAL_MS) * FINAL_RAMP_INTERVAL_MS
    );
  }

  return market.endMs;
}

async function upsertMarket(market) {
  await query(
    `
      insert into markets (id, symbol, start_time, end_time, status)
      values ($1, $2, $3, $4, 'open')
      on conflict (id) do nothing
    `,
    [market.id, market.symbol, market.start, market.end]
  );
}

async function heartbeat(status, marketId, message = null) {
  await query(
    `
      insert into collector_heartbeats
        (collector_name, last_seen_at, current_market_id, status, message, updated_at)
      values ($1, now(), $2, $3, $4, now())
      on conflict (collector_name) do update set
        last_seen_at = excluded.last_seen_at,
        current_market_id = excluded.current_market_id,
        status = excluded.status,
        message = excluded.message,
        updated_at = now()
    `,
    [COLLECTOR_NAME, marketId, status, message]
  );
}

async function recordError({ marketId, source, errorType, message, retryCount = 0 }) {
  await query(
    `
      insert into collection_errors (market_id, source, error_type, message, retry_count)
      values ($1, $2, $3, $4, $5)
    `,
    [marketId, source, errorType, message.slice(0, 500), retryCount]
  );
}

async function fetchPrice(sourceConfig) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = performance.now();

  try {
    const response = await fetch(sourceConfig.url(), { signal: controller.signal });
    const latencyMs = Math.round(performance.now() - started);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
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
  } finally {
    clearTimeout(timeout);
  }
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

async function collectSamples(market, scheduledAt, sampleType) {
  const results = await Promise.all(
    SOURCES.map((sourceConfig) => sampleSource(sourceConfig, market, scheduledAt, sampleType))
  );

  const failed = results.filter((result) => !result.ok);
  const message =
    failed.length > 0
      ? `${failed.length} source(s) failed at ${toIsoSeconds(scheduledAt)}`
      : `sampled ${sampleType} at ${toIsoSeconds(scheduledAt)}`;

  await heartbeat(failed.length > 0 ? "error" : "running", market.id, message);
}

async function labelSource(market, sourceConfig) {
  const sampleResult = await query(
    `
      with source_samples as (
        select scheduled_at, price
        from price_samples
        where symbol = $1
          and source = $2
          and scheduled_at >= $3
          and scheduled_at <= $4
      ),
      counts as (
        select
          count(*)::int as sample_count,
          min(scheduled_at) as first_sample_at,
          max(scheduled_at) as last_sample_at
        from source_samples
      ),
      open_sample as (
        select scheduled_at, price
        from source_samples
        order by scheduled_at asc
        limit 1
      ),
      close_sample as (
        select scheduled_at, price
        from source_samples
        order by scheduled_at desc
        limit 1
      )
      select
        counts.sample_count,
        counts.first_sample_at,
        counts.last_sample_at,
        open_sample.price as open_price,
        close_sample.price as close_price
      from counts
      left join open_sample on true
      left join close_sample on true
    `,
    [market.symbol, sourceConfig.source, market.start, market.end]
  );

  const row = sampleResult.rows[0];
  if (!row || !row.open_price || !row.close_price) {
    return { source: sourceConfig.source, quality: "missing" };
  }

  const openPrice = Number(row.open_price);
  const closePrice = Number(row.close_price);
  const sampleCount = Number(row.sample_count);
  const returnPct = ((closePrice - openPrice) / openPrice) * 100;
  const direction = closePrice > openPrice ? "up" : closePrice < openPrice ? "down" : "flat";
  const hasExactOpen = new Date(row.first_sample_at).getTime() === market.startMs;
  const hasExactClose = new Date(row.last_sample_at).getTime() === market.endMs;
  const quality =
    sampleCount >= EXPECTED_SAMPLES_PER_SOURCE && hasExactOpen && hasExactClose
      ? "complete"
      : "partial";

  await query(
    `
      insert into market_labels
        (
          market_id,
          source,
          open_price,
          close_price,
          return_pct,
          direction,
          sample_count,
          quality
        )
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      on conflict (market_id, source) do update set
        open_price = excluded.open_price,
        close_price = excluded.close_price,
        return_pct = excluded.return_pct,
        direction = excluded.direction,
        sample_count = excluded.sample_count,
        quality = excluded.quality,
        created_at = now()
    `,
    [
      market.id,
      sourceConfig.source,
      openPrice,
      closePrice,
      returnPct,
      direction,
      sampleCount,
      quality,
    ]
  );

  return { source: sourceConfig.source, quality };
}

async function closeMarket(market) {
  const labels = await Promise.all(SOURCES.map((sourceConfig) => labelSource(market, sourceConfig)));
  const complete = labels.every((label) => label.quality === "complete");
  const status = complete ? "closed" : "incomplete";

  await query(
    `
      update markets
      set status = $2, closed_at = now()
      where id = $1
    `,
    [market.id, status]
  );

  await heartbeat("running", market.id, `closed ${market.id} as ${status}`);
}

async function closeDueMarkets() {
  const result = await query(
    `
      select id, symbol, start_time, end_time
      from markets
      where status = 'open'
        and end_time <= now()
      order by end_time asc
      limit 10
    `
  );

  for (const row of result.rows) {
    const market = {
      id: row.id,
      symbol: row.symbol,
      start: new Date(row.start_time),
      end: new Date(row.end_time),
      startMs: new Date(row.start_time).getTime(),
      endMs: new Date(row.end_time).getTime(),
    };
    await closeMarket(market);
  }
}

async function run() {
  console.log(`${COLLECTOR_NAME} starting for ${SYMBOL}`);
  await heartbeat("running", null, "collector starting");
  await closeDueMarkets();

  while (!stopping) {
    const market = getMarketWindow();
    await upsertMarket(market);

    const scheduledMs = getNextScheduledMs(Date.now(), market);
    const waitMs = Math.max(0, scheduledMs - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    if (stopping) break;

    const scheduledAt = new Date(scheduledMs);
    const sampleType = getSampleType(scheduledMs, market);

    await collectSamples(market, scheduledAt, sampleType);

    if (scheduledMs >= market.endMs) {
      await closeMarket(market);
      await closeDueMarkets();
    }
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`received ${signal}, stopping collector`);
  try {
    await heartbeat("stopped", null, `stopped by ${signal}`);
  } finally {
    await closePool();
  }
}

process.on("SIGINT", () => {
  shutdown("SIGINT").finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM").finally(() => process.exit(0));
});

run()
  .catch(async (error) => {
    console.error(error);
    try {
      await heartbeat("error", null, error.message || String(error));
    } finally {
      await closePool();
    }
    process.exit(1);
  })
  .finally(async () => {
    if (!stopping) {
      await closePool();
    }
  });


