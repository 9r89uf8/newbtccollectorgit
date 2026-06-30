# CVD Implementation Plan

CVD should be a cumulative timestamp feature derived from the futures trade-flow buckets the collector already writes. The bucket delta is already available as `market_feature_buckets.net_taker_quote`:

```text
delta_quote = taker_buy_quote - taker_sell_quote
```

CVD is the running total of those deltas:

```text
cvd = previous_cvd + delta_quote
```

That means the chart should show two related things below price:

```text
delta_quote = per-bucket histogram bars
cvd_quote   = cumulative line
```

## Source Data

Use `market_feature_buckets` as the input table. It already has one row per planned timestamp bucket:

```text
56 five-second buckets: 0s, 5s, ... 275s
20 one-second final-ramp buckets: 280s, 281s, ... 299s
76 total pre-close buckets per complete market
```

Do not re-aggregate `agg_trades` for the normal CVD path unless rebuilding `market_feature_buckets` itself. Keeping CVD downstream of `market_feature_buckets` avoids drift between bucket deltas and CVD deltas.

## Values To Store

Store both reset-per-market CVD and true continuous CVD:

```text
cvd_market_quote
```

Resets at the start of each 5-minute Polymarket window. Best for studying one market's internal flow.

```text
cvd_continuous_quote
```

Keeps running across markets for the same `symbol` and `source`. Best for plotting a longer CVD line under BTC price.

The key rule is important:

```text
cvd_continuous_quote must be computed from all prior buckets, or seeded from the latest prior continuous CVD value.
```

A per-market-only window sum is not continuous. It would silently reset at each 5-minute market boundary.

## Recommended Table

Use a separate derived table first, so it can be recomputed without changing the existing bucket table.

```sql
create table if not exists market_cvd_buckets (
  market_id text not null references markets(id) on delete cascade,
  source text not null,
  symbol text not null,
  bucket_start timestamptz not null,
  bucket_end timestamptz not null,
  bucket_seconds numeric(14, 3) not null,

  open_price numeric(20, 8),
  close_price numeric(20, 8),
  return_pct numeric(14, 8),
  return_bps numeric(14, 8),

  taker_buy_quote numeric(30, 8) not null default 0,
  taker_sell_quote numeric(30, 8) not null default 0,
  delta_quote numeric(30, 8) not null default 0,

  cvd_market_quote numeric(30, 8) not null default 0,
  cvd_continuous_quote numeric(30, 8) not null default 0,

  cvd_change_5b numeric(30, 8),
  price_change_5b_bps numeric(14, 8),

  cvd_direction text,
  price_direction text,
  cvd_price_behavior text,
  cvd_divergence_5b text,
  bucket_quality text not null check (bucket_quality in ('complete', 'partial', 'missing')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (market_id, source, bucket_start)
);

create index if not exists market_cvd_buckets_symbol_source_time_idx
  on market_cvd_buckets (symbol, source, bucket_start desc);
```

Include `source` in the primary key because the existing bucket table is keyed by `(market_id, source, bucket_start)`.

## Full Recompute Query

For a full backfill/recompute, calculate market CVD and continuous CVD over all available buckets:

```sql
with bucket_delta as (
  select
    b.market_id,
    b.source,
    b.symbol,
    b.bucket_start,
    b.bucket_end,
    b.bucket_seconds,
    b.open_price,
    b.close_price,
    b.return_pct,
    case
      when b.open_price is not null and b.open_price != 0 and b.close_price is not null
        then (b.close_price - b.open_price) / b.open_price * 10000
      else null
    end as return_bps,
    b.taker_buy_quote,
    b.taker_sell_quote,
    b.net_taker_quote as delta_quote,
    b.bucket_quality
  from market_feature_buckets b
),
bucket_cvd as (
  select
    *,
    sum(delta_quote) over (
      partition by market_id, source
      order by bucket_start
      rows between unbounded preceding and current row
    ) as cvd_market_quote,
    sum(delta_quote) over (
      partition by symbol, source
      order by bucket_start, market_id
      rows between unbounded preceding and current row
    ) as cvd_continuous_quote
  from bucket_delta
),
bucket_signals as (
  select
    *,
    cvd_market_quote
      - lag(cvd_market_quote, 5) over (
          partition by market_id, source
          order by bucket_start
        ) as cvd_change_5b,
    case
      when lag(close_price, 5) over (
        partition by market_id, source
        order by bucket_start
      ) is not null
      and lag(close_price, 5) over (
        partition by market_id, source
        order by bucket_start
      ) != 0
      then (
        close_price
        - lag(close_price, 5) over (
            partition by market_id, source
            order by bucket_start
          )
      )
      / lag(close_price, 5) over (
          partition by market_id, source
          order by bucket_start
        ) * 10000
      else null
    end as price_change_5b_bps
  from bucket_cvd
)
insert into market_cvd_buckets (
  market_id,
  source,
  symbol,
  bucket_start,
  bucket_end,
  bucket_seconds,
  open_price,
  close_price,
  return_pct,
  return_bps,
  taker_buy_quote,
  taker_sell_quote,
  delta_quote,
  cvd_market_quote,
  cvd_continuous_quote,
  cvd_change_5b,
  price_change_5b_bps,
  cvd_direction,
  price_direction,
  cvd_price_behavior,
  cvd_divergence_5b,
  bucket_quality,
  updated_at
)
select
  market_id,
  source,
  symbol,
  bucket_start,
  bucket_end,
  bucket_seconds,
  open_price,
  close_price,
  return_pct,
  return_bps,
  taker_buy_quote,
  taker_sell_quote,
  delta_quote,
  cvd_market_quote,
  cvd_continuous_quote,
  cvd_change_5b,
  price_change_5b_bps,
  case
    when delta_quote > 0 then 'cvd_up'
    when delta_quote < 0 then 'cvd_down'
    else 'cvd_flat'
  end as cvd_direction,
  case
    when return_bps > 1.0 then 'price_up'
    when return_bps < -1.0 then 'price_down'
    else 'price_flat'
  end as price_direction,
  case
    when delta_quote > 0 and return_bps > 1.0 then 'buyers_in_control'
    when delta_quote > 0 and abs(return_bps) <= 1.0 then 'buy_pressure_absorbed_by_sellers'
    when delta_quote < 0 and abs(return_bps) <= 1.0 then 'sell_pressure_absorbed_by_buyers'
    when delta_quote < 0 and return_bps < -1.0 then 'sellers_in_control'
    when delta_quote > 0 and return_bps < -1.0 then 'aggressive_buying_failed'
    when delta_quote < 0 and return_bps > 1.0 then 'aggressive_selling_failed'
    else 'neutral'
  end as cvd_price_behavior,
  case
    when cvd_change_5b > 0 and price_change_5b_bps > 1.0 then 'buyers_in_control'
    when cvd_change_5b > 0 and abs(price_change_5b_bps) <= 1.0 then 'sellers_absorbing_buy_pressure'
    when cvd_change_5b < 0 and abs(price_change_5b_bps) <= 1.0 then 'buyers_absorbing_sell_pressure'
    when cvd_change_5b < 0 and price_change_5b_bps < -1.0 then 'sellers_in_control'
    when cvd_change_5b > 0 and price_change_5b_bps < -1.0 then 'buying_failed_bearish'
    when cvd_change_5b < 0 and price_change_5b_bps > 1.0 then 'selling_failed_bullish'
    else 'neutral'
  end as cvd_divergence_5b,
  bucket_quality,
  now()
from bucket_signals
on conflict (market_id, source, bucket_start) do update set
  symbol = excluded.symbol,
  bucket_end = excluded.bucket_end,
  bucket_seconds = excluded.bucket_seconds,
  open_price = excluded.open_price,
  close_price = excluded.close_price,
  return_pct = excluded.return_pct,
  return_bps = excluded.return_bps,
  taker_buy_quote = excluded.taker_buy_quote,
  taker_sell_quote = excluded.taker_sell_quote,
  delta_quote = excluded.delta_quote,
  cvd_market_quote = excluded.cvd_market_quote,
  cvd_continuous_quote = excluded.cvd_continuous_quote,
  cvd_change_5b = excluded.cvd_change_5b,
  price_change_5b_bps = excluded.price_change_5b_bps,
  cvd_direction = excluded.cvd_direction,
  price_direction = excluded.price_direction,
  cvd_price_behavior = excluded.cvd_price_behavior,
  cvd_divergence_5b = excluded.cvd_divergence_5b,
  bucket_quality = excluded.bucket_quality,
  updated_at = now();
```

## Incremental Collector Query

For the normal collector path, materializing one just-closed market at a time, seed continuous CVD from the latest prior CVD row:

```sql
with prior as (
  select coalesce(cvd_continuous_quote, 0) as cvd_seed
  from market_cvd_buckets
  where symbol = $1
    and source = $2
    and bucket_start < $3
  order by bucket_start desc
  limit 1
),
current_market as (
  select
    b.*,
    b.net_taker_quote as delta_quote
  from market_feature_buckets b
  where b.symbol = $1
    and b.source = $2
    and b.market_id = $4
)
select
  *,
  sum(delta_quote) over (
    partition by market_id, source
    order by bucket_start
  ) as cvd_market_quote,
  coalesce((select cvd_seed from prior), 0)
    + sum(delta_quote) over (order by bucket_start) as cvd_continuous_quote
from current_market;
```

If an older market is backfilled or recomputed, recompute `cvd_continuous_quote` from that market forward. Every later continuous value depends on the changed delta history.

## Behavior Logic

Use bucket delta for immediate behavior and use 5-bucket CVD change for the better divergence signal.

| Flow / Price | Meaning |
| --- | --- |
| Positive delta, price up | Buyers in control |
| Positive delta, price flat | Sellers absorbing aggressive buyers |
| Negative delta, price flat | Buyers absorbing aggressive sellers |
| Negative delta, price down | Sellers in control |
| Positive delta, price down | Aggressive buying failed |
| Negative delta, price up | Aggressive selling failed |

The 5-bucket comparison should use:

```text
cvd_change_5b = current_cvd_market_quote - cvd_market_quote_from_5_buckets_ago
price_change_5b_bps = current_close_price - close_price_from_5_buckets_ago, in bps
```

Five buckets is about 25 seconds during the normal part of the market and 5 seconds during the final ramp.

## Chart Plan

In the market detail chart:

```text
BTC price panel
CVD panel below price:
  - bars: delta_quote, the existing net taker bucket value
  - line: cvd_market_quote for this 5-minute market
```

For a longer cross-market chart, use:

```text
line: cvd_continuous_quote
bars: delta_quote
```

The existing `Net taker` bars are already the delta histogram. The missing piece is the cumulative CVD line.

## Market-Level Summary Fields

Later, roll these up into market-level features:

```text
cvd_open_quote
cvd_close_quote
cvd_change_quote
cvd_high_quote
cvd_low_quote
cvd_range_quote
cvd_slope
cvd_positive_bucket_count
cvd_negative_bucket_count
buy_absorption_bucket_count
sell_absorption_bucket_count
buyers_control_bucket_count
sellers_control_bucket_count
final_20s_cvd_change_quote
final_20s_price_change_bps
final_20s_behavior
```

The final 20 seconds matter because the collector switches to 1-second samples from 280s through 299s.

## Live vs Post-Market

With the current setup, Binance Futures aggregate trades are fetched after each market closes. That makes this CVD a post-market feature.

A live CVD chart would require adding a Binance Futures trade WebSocket such as aggTrade/trade. The existing futures WebSocket summaries currently cover book ticker and liquidation events, not aggressive trade flow.

## Implementation Order

1. Add `market_cvd_buckets` to `db/schema.sql`.
2. Add a collector materializer after `writeMarketFeatureBuckets(market)`.
3. Add a backfill script that full-recomputes from `market_feature_buckets`.
4. Add CVD rows to `lib/marketDetailData.js` or include the CVD fields with bucket rows.
5. Update the market detail chart to plot `delta_quote` bars plus the cumulative `cvd_market_quote` line.

Do not run the Droplet deploy script until collector/runtime changes are committed and pushed. This plan is docs-only until implementation starts.