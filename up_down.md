You have **two different things mixed together**:

1. **A real Polymarket data-availability problem:** CLOB midpoint exists only once the relevant outcome token has a usable book. Polymarket documents midpoint as the average of best bid and best ask, and the batch endpoint returns a token-id-to-midpoint map; if the book is not live or one side is missing, there may simply be no midpoint yet. ([Polymarket Documentation][1]) ([Polymarket Documentation][2])
2. **A collector behavior problem:** your runtime can skip the current market’s own `0s` collection when the previous Binance close is available, even though that does **not** prove the next market’s Polymarket `0s` probability sample succeeded. Your close-boundary path attempts `collectNextMarketOpeningPolymarketSample(...)`, but the later `runCollector()` branch continues early on `previousClose.available`.

The practical result: if the boundary Polymarket request fails at `0s`, your next chance may be the normal `5s`, `10s`, or `15s` sample. If Polymarket becomes available at `6s`, your 5-second cadence naturally records first complete data at `10s`. If it becomes available at `11s`, you record first complete data at `15s`.

## The most important code fix

Do **not** skip the current market’s Polymarket opening sample just because Binance close rows exist.

Right now this block is too broad:

```js
if (scheduledMs === market.startMs && previousClose.available) {
  await heartbeat(
    COLLECTOR_NAME,
    "running",
    market.id,
    `boundary close available at ${toIsoSeconds(scheduledAt)}`
  );
  continue;
}
```

That is safe for Binance price rows, but not safe for Polymarket. Change it to still try the Polymarket opening row:

```js
async function collectOpeningPolymarketSampleIfNeeded(market, scheduledAt) {
  if (!ENABLE_POLYMARKET_BTC_5M) {
    return { ok: true, skipped: true };
  }

  const existing = await query(
    `
      select quality
      from polymarket_probability_samples
      where source = $1
        and market_id = $2
        and scheduled_at = $3
      limit 1
    `,
    [POLYMARKET_5M_BTC_SOURCE.probabilitySource, market.id, scheduledAt]
  );

  if (existing.rows[0]?.quality === "complete") {
    return { ok: true, skipped: true, quality: "complete" };
  }

  return collectPolymarketProbabilitySample(market, scheduledAt, "normal");
}
```

Then change the skip block:

```js
if (scheduledMs === market.startMs && previousClose.available) {
  const polyResult = await collectOpeningPolymarketSampleIfNeeded(
    market,
    scheduledAt
  );

  await heartbeat(
    COLLECTOR_NAME,
    polyResult.ok ? "running" : "error",
    market.id,
    `boundary close available at ${toIsoSeconds(scheduledAt)}; opening polymarket ${
      polyResult.skipped ? "already present" : polyResult.quality || "attempted"
    }`
  );

  continue;
}
```

This gives Polymarket a second immediate chance at `0s` while still avoiding duplicate Binance close/open rows.

## Add a non-blocking first-20-seconds retry loop

A single retry at `0s` still will not help if Polymarket’s book appears at `T+8s`. The cleanest fix is a **Polymarket-only opening retry task** that keeps trying to write the `scheduled_at = market.start_time` row for the first 15–20 seconds, without blocking Binance sampling.

Add this in `runtime.mjs`:

```js
const pendingPolymarketOpeningRetries = new Map();
const POLYMARKET_OPENING_RETRY_MS = 1_000;
const POLYMARKET_OPENING_RETRY_WINDOW_MS = 20_000;

function schedulePolymarketOpeningRetry(market, scheduledAt) {
  if (!ENABLE_POLYMARKET_BTC_5M) return;

  const key = `${market.id}:${scheduledAt.getTime()}`;
  if (pendingPolymarketOpeningRetries.has(key)) return;

  const promise = (async () => {
    const deadlineMs =
      scheduledAt.getTime() + POLYMARKET_OPENING_RETRY_WINDOW_MS;

    while (!stopping && Date.now() <= deadlineMs) {
      const result = await collectPolymarketProbabilitySample(
        market,
        scheduledAt,
        "normal"
      );

      if (result.ok && result.quality === "complete") {
        return;
      }

      await sleep(POLYMARKET_OPENING_RETRY_MS);
    }
  })()
    .catch(async (error) => {
      await recordError({
        marketId: market.id,
        source: POLYMARKET_5M_BTC_SOURCE.probabilitySource,
        errorType: "polymarket_opening_retry_error",
        message: error.message || String(error),
      });
    })
    .finally(() => {
      pendingPolymarketOpeningRetries.delete(key);
    });

  pendingPolymarketOpeningRetries.set(key, promise);
}
```

Then call it when the boundary/opening sample is missing or incomplete:

```js
async function collectNextMarketOpeningPolymarketSample(market, scheduledAt) {
  if (!ENABLE_POLYMARKET_BTC_5M || scheduledAt.getTime() !== market.endMs) {
    return {
      ok: true,
      source: POLYMARKET_5M_BTC_SOURCE.probabilitySource,
      skipped: true,
    };
  }

  const nextMarket = getNextMarketAfter(market);
  await upsertMarket(nextMarket);
  await prefetchPolymarketMarketMetadata(nextMarket, scheduledAt.getTime());

  const result = await collectPolymarketProbabilitySample(
    nextMarket,
    scheduledAt,
    "normal"
  );

  if (!result.ok || result.quality !== "complete") {
    schedulePolymarketOpeningRetry(nextMarket, scheduledAt);
  }

  return result;
}
```

Also call it in the `previousClose.available` skip branch after the immediate retry:

```js
if (
  !polyResult.ok ||
  (polyResult.quality && polyResult.quality !== "complete")
) {
  schedulePolymarketOpeningRetry(market, scheduledAt);
}
```

This will not create duplicate rows because your probability table already upserts on `(source, market_id, scheduled_at)`. Your existing insert/update path updates `collected_at`, probabilities, `quality`, and `raw_response` on conflict.

## Add a delay flag so you do not lie to yourself

If you retry at `T+9s` and write into `scheduled_at = T+0s`, that is not a true `0s` midpoint. It is the **first available opening midpoint**, collected late.

Add columns like:

```sql
alter table polymarket_probability_samples
  add column if not exists data_delay_ms integer,
  add column if not exists availability_status text;
```

Then set:

```sql
data_delay_ms = greatest(
  0,
  extract(epoch from (collected_at - scheduled_at)) * 1000
)
```

Suggested meanings:

```text
availability_status = 'on_time'        -- collected near scheduled_at
availability_status = 'delayed_open'   -- scheduled_at is market start, collected later
availability_status = 'missing'        -- attempted but no usable midpoint
availability_status = 'metadata_missing'
availability_status = 'timeout'
```

For modeling, I would not treat a delayed `0s` midpoint as the same as a real `0s` midpoint. Use it for chart continuity if needed, but include `data_delay_ms` and maybe exclude `data_delay_ms > 2000` from strict open-feature training.

## Persist missing attempts

Right now `collectPolymarketProbabilitySample()` only inserts a probability sample after `ensurePolymarketMarket()` and `fetchMidpoints()` succeed enough to reach `insertProbabilitySample(...)`. If `ensurePolymarketMarket()` throws because token IDs are missing, you record an error but do **not** insert a `missing` probability row. That makes your SQL look like “first row starts at 10s,” when the collector may actually have attempted `0s` and `5s`.

Add a missing-row insert in the catch path. Assuming `up_token_id` and `down_token_id` are nullable:

```js
async function insertMissingProbabilitySample(
  market,
  scheduledAt,
  sampleType,
  { slug = null, errorType = null, errorMessage = null } = {}
) {
  await query(
    `
      insert into polymarket_probability_samples
        (
          source,
          market_id,
          symbol,
          slug,
          scheduled_at,
          collected_at,
          sample_type,
          up_token_id,
          down_token_id,
          up_probability,
          down_probability,
          up_probability_normalized,
          down_probability_normalized,
          probability_sum,
          request_latency_ms,
          quality,
          raw_response
        )
      values (
        $1, $2, $3, $4, $5, now(), $6,
        null, null,
        null, null, null, null, null,
        null,
        'missing',
        $7::jsonb
      )
      on conflict (source, market_id, scheduled_at) do update set
        collected_at = excluded.collected_at,
        sample_type = excluded.sample_type,
        quality = excluded.quality,
        raw_response = excluded.raw_response,
        updated_at = now()
    `,
    [
      POLYMARKET_5M_BTC_SOURCE.probabilitySource,
      market.id,
      market.symbol,
      slug || slugForMarket(market),
      scheduledAt,
      sampleType,
      JSON.stringify({ errorType, errorMessage }),
    ]
  );
}
```

Then in `collectPolymarketProbabilitySample()`:

```js
  } catch (error) {
    const errorType =
      error.name === "AbortError"
        ? "timeout"
        : "polymarket_probability_fetch_error";

    await insertMissingProbabilitySample(market, scheduledAt, sampleType, {
      errorType,
      errorMessage: error.message || String(error),
    });

    await recordError({
      marketId: market.id,
      source: POLYMARKET_5M_BTC_SOURCE.probabilitySource,
      errorType,
      message: error.message || String(error),
    });

    return { ok: false, source: POLYMARKET_5M_BTC_SOURCE.probabilitySource, error };
  }
```

If `up_token_id` and `down_token_id` are `not null`, use a separate table such as `polymarket_probability_sample_attempts` instead. The point is to distinguish:

```text
collector did not try
collector tried but metadata missing
collector tried but midpoint missing
collector tried and got partial data
collector got complete Up/Down midpoint data
```

## Use WebSocket for earliest possible first quote

REST polling every 5 seconds will always quantize availability. Polymarket’s docs recommend WebSocket for live orderbook data, and the market channel can stream orderbook snapshots, price changes, trades, and `best_bid_ask` when `custom_feature_enabled: true`. ([Polymarket Documentation][3]) ([Polymarket Documentation][2])

For these 5-minute markets, the best architecture is:

1. Prefetch Gamma metadata and token IDs before start.
2. Subscribe to the next market’s Up/Down token IDs as soon as they are known.
3. Cache latest best bid/ask per token.
4. At scheduled timestamps, write the latest cached midpoint with an `asof` timestamp.
5. During the first 20 seconds, also let WebSocket events complete the delayed-open row as soon as both Up and Down have usable top-of-book.

This gives you the real first observed CLOB quote time instead of waiting for the next 5-second REST tick.

## Better diagnostics query

Use this to see how often the problem is truly delayed availability versus missing rows:

```sql
with per_market as (
  select
    m.id as market_id,
    m.start_time,
    min(p.scheduled_at) filter (where p.quality = 'complete') as first_complete_at,
    min(p.collected_at) filter (where p.quality = 'complete') as first_complete_collected_at,
    count(*) filter (
      where p.scheduled_at >= m.start_time
        and p.scheduled_at < m.start_time + interval '20 seconds'
    ) as rows_first_20s,
    count(*) filter (
      where p.scheduled_at >= m.start_time
        and p.scheduled_at < m.start_time + interval '20 seconds'
        and p.quality = 'missing'
    ) as missing_rows_first_20s,
    count(*) filter (
      where p.scheduled_at >= m.start_time
        and p.scheduled_at < m.start_time + interval '20 seconds'
        and p.quality = 'complete'
    ) as complete_rows_first_20s
  from markets m
  left join polymarket_probability_samples p
    on p.market_id = m.id
   and p.source = '<polymarket_probability_source>'
  where m.symbol = 'BTCUSDT'
  group by m.id, m.start_time
)
select
  market_id,
  start_time,
  extract(epoch from first_complete_at - start_time) as first_complete_scheduled_offset_s,
  extract(epoch from first_complete_collected_at - start_time) as first_complete_collection_offset_s,
  rows_first_20s,
  missing_rows_first_20s,
  complete_rows_first_20s
from per_market
order by start_time desc;
```

After you add missing-attempt rows, this query becomes much more useful. A market with rows at `0s` and `5s` marked `missing`, then `10s` complete, is a Polymarket availability issue. A market with no `0s` row at all is a collector instrumentation issue.

## Recommended interpretation

Do **not** mark the whole market incomplete just because Polymarket starts late. Binance labels can still be complete. But add market-level Polymarket coverage fields:

```text
polymarket_first_complete_offset_s
polymarket_opening_quality
polymarket_opening_data_delay_ms
polymarket_complete_sample_count
polymarket_missing_sample_count
```

Then your models and charts can handle it cleanly:

```sql
case
  when polymarket_first_complete_offset_s is null then 'no_polymarket'
  when polymarket_first_complete_offset_s <= 2 then 'on_time'
  when polymarket_first_complete_offset_s <= 15 then 'delayed_open'
  else 'late_or_sparse'
end as polymarket_opening_coverage
```

The key conclusion: you cannot recover a true CLOB midpoint for `0s` if Polymarket did not publish a usable book yet, but you **can** stop losing attempts, stop skipping the current market’s opening Polymarket retry, and capture the first available quote much closer to its real arrival time.

[1]: https://docs.polymarket.com/api-reference/market-data/get-midpoint-prices-request-body "Get midpoint prices (request body) - Polymarket Documentation"
[2]: https://docs.polymarket.com/trading/orderbook "Orderbook - Polymarket Documentation"
[3]: https://docs.polymarket.com/market-data/websocket/market-channel "Market Channel - Polymarket Documentation"
