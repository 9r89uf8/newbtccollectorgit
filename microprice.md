# Microprice Bucket Plan

Verdict: the idea is right, but the first draft should not be implemented as-is.

The right shape is to derive a market-scoped microprice bucket table from the existing `futures_ws_1s_summaries` rows. Do not add another raw feed. The table should sit beside `market_cvd_buckets`, but its source is the WebSocket summary feed, `binance_futures_ws`, not the REST futures microstructure source, `binance_futures`.

## What This Adds

`market_cvd_buckets` answers:

```text
What did aggressive taker flow do?
```

`market_microprice_buckets` should answer:

```text
Where did top-of-book passive liquidity lean?
```

The useful first version is:

```text
1 row per market second
normalized top-of-book microprice lean
10s and 30s rolling lean persistence
market cumulative pressure
continuous cumulative pressure
simple behavior labels
coverage and staleness fields
```

## Source Rows

Use only `futures_ws_1s_summaries`.

Relevant existing fields:

```text
bucket_start
bucket_end
summary_quality
book_ticker_update_count
best_bid_price_close
best_bid_qty_close
best_ask_price_close
best_ask_qty_close
mid_price_close
spread_bps_close
spread_bps_avg
spread_bps_max
microprice_close
microprice_bps_from_mid_close
```

The data model already defines these WebSocket rows as the short-horizon prediction row source. That makes this a derived feature table, not a new collector input.

## Critical Corrections To The Draft

Use a market-derived primary key:

```sql
primary key (market_id, source, bucket_start)
```

This matches `market_feature_buckets` and `market_cvd_buckets`. It also keeps delete/recompute behavior market-scoped.

Keep `created_at` stable and add `updated_at`:

```sql
created_at timestamptz not null default now(),
updated_at timestamptz not null default now()
```

On conflict, update `updated_at`, not `created_at`.

Do not use row-count windows unless the materializer guarantees one row per second. The safer implementation is to generate the 300 expected market seconds and join or carry forward the latest valid WebSocket book-ticker state. If the implementation only selects existing WebSocket rows, then "10s" and "30s" are actually "last 10 rows" and "last 30 rows", which is not always the same thing.

Track coverage and staleness. Missing WebSocket seconds are possible, and a no-update second can mean either an unchanged book or a stale connection. The bucket table should expose enough information to filter weak signals.

## Normalized Lean

Raw microprice distance is useful:

```text
microprice_bps_from_mid =
  (microprice - mid_price) / mid_price * 10000
```

For signal logic, use normalized lean:

```text
microprice_lean =
  2 * microprice_bps_from_mid / spread_bps
```

This is roughly bounded between `-1` and `+1` when the quoted spread is valid.

Interpretation:

```text
+1.00 = microprice close to ask
 0.00 = balanced top of book
-1.00 = microprice close to bid
```

With the Binance top-of-book formula currently used by the collector, this is equivalent to:

```text
(best_bid_qty - best_ask_qty) / (best_bid_qty + best_ask_qty)
```

So:

```text
positive = bid side heavier = upward pressure
negative = ask side heavier = downward pressure
```

Guardrails:

```text
spread_bps_close must be > 0
mid_price_close must be > 0
microprice_close must be present
best bid/ask quantities should not both be zero
```

If these are not true, set `microprice_lean` to null and mark the row quality/staleness accordingly.

## Recommended Table

Use existing schema conventions for numeric precision and timestamps:

```sql
create table if not exists market_microprice_buckets (
  market_id text not null references markets(id) on delete cascade,
  source text not null,
  symbol text not null,

  bucket_start timestamptz not null,
  bucket_end timestamptz not null,
  bucket_seconds numeric(14, 3) not null default 1,

  source_summary_quality text,
  book_ticker_update_count integer not null default 0,
  seconds_since_book_update numeric(14, 3),

  best_bid_price numeric(20, 8),
  best_bid_qty numeric(30, 12),
  best_ask_price numeric(20, 8),
  best_ask_qty numeric(30, 12),
  mid_price numeric(20, 8),
  spread_bps_close numeric(14, 8),
  spread_bps_avg numeric(14, 8),
  spread_bps_max numeric(14, 8),

  microprice numeric(20, 8),
  microprice_bps_from_mid numeric(14, 8),
  microprice_lean numeric(14, 8),
  microprice_delta numeric(14, 8) not null default 0,

  microprice_pressure_market numeric(30, 8) not null default 0,
  microprice_pressure_continuous numeric(30, 8) not null default 0,

  avg_lean_10s numeric(14, 8),
  avg_lean_30s numeric(14, 8),
  up_lean_share_10s numeric(14, 8),
  down_lean_share_10s numeric(14, 8),
  up_lean_share_30s numeric(14, 8),
  down_lean_share_30s numeric(14, 8),
  valid_sample_count_10s integer not null default 0,
  valid_sample_count_30s integer not null default 0,

  spread_stable_10s boolean,
  spread_stable_30s boolean,
  mid_change_10s_bps numeric(14, 8),
  mid_change_30s_bps numeric(14, 8),
  price_stalled_10s boolean,
  price_stalled_30s boolean,

  lean_direction text,
  persistence_signal text,
  flip_signal text,
  microprice_behavior text,

  bucket_quality text not null check (bucket_quality in ('complete', 'partial', 'missing', 'stale')),
  feature_version text not null default 'microprice_v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (market_id, source, bucket_start)
);

create index if not exists market_microprice_buckets_source_time_idx
  on market_microprice_buckets (source, bucket_start desc);

create index if not exists market_microprice_buckets_symbol_source_time_idx
  on market_microprice_buckets (symbol, source, bucket_start desc);
```

Consider adding it to the Timescale hypertable list in `scripts/setupDb.mjs`, because this table is one row per second and can grow much faster than CVD buckets.

## Materialization

Add a plain JavaScript module:

```text
collector/marketMicropriceBuckets.mjs
```

Export:

```text
writeMarketMicropriceBuckets(market)
refreshRecentMicropriceBuckets(limit = 4)
```

Also add:

```text
scripts/backfillMicropriceBuckets.mjs
```

Runtime placement:

```text
closeMarket()
  writeMarketFeatures()
  writeMarketFeatureBuckets()
  writeMarketCvdBuckets()
  writeMarketMicropriceBuckets()
  writeMarketBehaviorLabel()
  writeMarketClassification()
  writeMarketForwardLabels()
```

Gate it behind `ENABLE_FUTURES_MICROSTRUCTURE && ENABLE_FUTURES_WEBSOCKET_SUMMARIES`.

Because WebSocket summaries flush with a lag, refresh recent microprice buckets after market close the same way forward labels refresh recent markets. Otherwise the final 1-2 seconds of a just-closed market may be missing during the first write.

## Boundary Rules

Use the same explanatory-feature boundary rule as the rest of the data model:

```sql
bucket_start >= market.start_time
and bucket_start < market.end_time
```

The exact close boundary belongs to the next market, not the just-closed market.

For a complete 5 minute market, target:

```text
300 one-second microprice buckets
```

That differs from REST `market_feature_buckets`, which has 76 scheduled buckets.

## Window Logic

Prefer actual time windows over row-count windows.

If the table materializes exactly one row per market second, this is fine:

```sql
rows between 9 preceding and current row
rows between 29 preceding and current row
```

If rows are not guaranteed to be one per second, use timestamp range windows or generate the missing seconds first:

```sql
range between interval '9 seconds' preceding and current row
range between interval '29 seconds' preceding and current row
```

Only emit persistence labels when coverage is high enough:

```text
10s signal: at least 8 valid samples in the 10s window
30s signal: at least 24 valid samples in the 30s window
```

The exact coverage threshold can be tuned later. The important point is that persistence labels should not be created from one or two isolated WebSocket rows.

## First Thresholds

Start simple:

```text
lean threshold:
abs(microprice_lean) >= 0.20

10s persistence:
avg_lean_10s >= 0.20 or <= -0.20
same-direction share >= 0.70
valid_sample_count_10s >= 8
spread_stable_10s = true

30s persistence:
avg_lean_30s >= 0.20 or <= -0.20
same-direction share >= 0.70
valid_sample_count_30s >= 24
spread_stable_30s = true

spread stable:
max spread in window <= 1.5x average spread in window

price stalled:
10s: abs(mid change) <= max(0.50 bps, 2x current spread)
30s: abs(mid change) <= max(0.75 bps, 2x current spread)
```

Use `spread_bps_close` for the current threshold and `spread_bps_avg`/`spread_bps_max` for stability checks.

## Behavior Labels

Start with:

```text
persistent_up_10s
persistent_down_10s
persistent_up_30s
persistent_down_30s
up_pressure_absorbed
down_pressure_absorbed
bullish_microprice_flip_while_stalled
bearish_microprice_flip_while_stalled
strong_upward_book_pressure
strong_downward_book_pressure
neutral
```

For absorbed-pressure labels, use the matching stall window:

```text
persistent_up_10s + price_stalled_10s = up_pressure_absorbed
persistent_up_30s + price_stalled_30s = up_pressure_absorbed
persistent_down_10s + price_stalled_10s = down_pressure_absorbed
persistent_down_30s + price_stalled_30s = down_pressure_absorbed
```

The draft used `price_stalled_10s` for both 10s and 30s persistence. That should be corrected.

## Continuous Pressure

Use:

```text
microprice_delta = coalesce(microprice_lean, 0) * bucket_seconds
```

Then:

```text
microprice_pressure_market = running sum inside the market
microprice_pressure_continuous = running sum across source + symbol
```

Like CVD, continuous pressure depends on prior rows. If an older market is backfilled or recomputed, later continuous rows should be recomputed too, or the materializer must seed from all prior history consistently.

## Dashboard Fields

Chart only the useful fields first:

```text
mid_price
microprice_lean
avg_lean_10s
avg_lean_30s
microprice_pressure_market
persistence_signal
microprice_behavior
```

The visual companion to the current CVD chart should be:

```text
price line
microprice_pressure_market line
10s/30s persistence markers
```

Useful reads:

```text
price rising + microprice pressure rising = clean upward pressure
price flat + persistent positive microprice = bid pressure being absorbed
price flat + positive microprice flips negative = possible bearish reversal
price falling + microprice pressure falling = clean downward pressure
price flat + persistent negative microprice = ask pressure being absorbed
price flat + negative microprice flips positive = possible bullish reversal
```

## Files To Change When Implementing

Minimum implementation list:

```text
db/schema.sql
scripts/setupDb.mjs
scripts/clearData.mjs
collector/marketMicropriceBuckets.mjs
collector/runtime.mjs
scripts/backfillMicropriceBuckets.mjs
README.md
docs/data-model.md
lib/marketDetailData.js
app/markets/[marketId]/page.js
app/markets/[marketId]/MarketMicrostructureChart.js
```

Keep it plain JavaScript. No TypeScript, no Docker, no backup jobs.

Because this will change collector runtime behavior and schema, use the Droplet deploy script only after the implementation is committed and pushed, per the repo instructions.

## Bottom Line

The plan is directionally correct:

```text
futures_ws_1s_summaries
  -> market_microprice_buckets
  -> dashboard and prediction features
```

The important fixes are:

```text
market-scoped primary key
stable created_at plus updated_at
coverage/staleness fields
true 1-second market buckets or time-range windows
matching 10s/30s stall logic
continuous-pressure recompute rules
close-boundary and WebSocket flush handling
```
