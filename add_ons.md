# Add Ons: Futures Microstructure V1

This repo implements the first two data additions:

1. Binance Futures aggregate trades for aggressive buy/sell flow.
2. Binance Futures top-20 order book depth for available liquidity.

It also derives per-timestamp bucket summaries so the dashboard can show what was happening at a specific point inside each 5 minute market.

## Implemented Files

| File | Responsibility |
| --- | --- |
| `collector/collector.mjs` | Small process entrypoint and signal handling. |
| `collector/runtime.mjs` | Main market loop and close workflow. |
| `collector/config.mjs` | Collector constants, env settings, and Binance URLs. |
| `collector/time.mjs` | Market windows and scheduled sample times. |
| `collector/http.mjs` | Timed JSON fetch helper. |
| `collector/store.mjs` | Shared database writes for markets, heartbeats, and errors. |
| `collector/priceSamples.mjs` | Spot and futures last-price sampling. |
| `collector/bookSamples.mjs` | Futures top-20 depth fetch and derived book metrics. |
| `collector/aggTrades.mjs` | Futures aggregate trade pagination and raw inserts. |
| `collector/marketLabels.mjs` | Open/close labels. |
| `collector/marketFeatures.mjs` | Per-market trade-flow and book-liquidity features. |
| `collector/marketFeatureBuckets.mjs` | Per-timestamp interval summaries inside each market. |

## Data Tables

The schema adds these microstructure tables:

```text
agg_trades
book_samples
market_features
market_feature_buckets
```

`agg_trades` stores raw futures aggregate trades.

`book_samples` stores derived top-20 book metrics at scheduled sample times.

`market_features` stores one 5 minute futures summary per market.

`market_feature_buckets` stores per-timestamp interval summaries such as:

```text
At 16:05:00 UTC
net_taker_quote = -581240
taker_imbalance = -0.014
book_imbalance_5bps = +0.182
spread_bps = +0.02
```

## Raw Plus Derived

Do not replace raw tables with summaries. Keep both:

- raw rows let you recompute features when logic changes
- market summaries make broad analysis fast
- timestamp buckets explain when and why price moved inside a market

Each bucket covers trades from `bucket_start` up to, but not including, `bucket_end`. The book values are the snapshot at `bucket_start`, and the price fields describe the futures price move from `bucket_start` to `bucket_end`.

## REST First

The original add-on notes described Binance websocket streams. Those are still valid for a later lower-latency collector, but the implemented V1 uses REST endpoints because it fits the existing scheduled collector loop and avoids adding a websocket dependency.

The REST endpoints used are:

```text
GET https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=20
GET https://fapi.binance.com/fapi/v1/aggTrades?symbol=BTCUSDT&...
```

Official Binance references:

- https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Order-Book
- https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Compressed-Aggregate-Trades-List
- https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Aggregate-Trade-Streams
- https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Partial-Book-Depth-Streams

## No-Leakage Rule

Labels use the close-boundary price sample:

```sql
scheduled_at >= market.start_time
and scheduled_at <= market.end_time
```

Features and buckets do not use the close boundary as a feature timestamp:

```sql
scheduled_at >= market.start_time
and scheduled_at < market.end_time
```

The final bucket can end at `market.end_time` so it can measure the last pre-close interval, but the bucket starts before the label boundary.

## Env Settings

```text
ENABLE_FUTURES_MICROSTRUCTURE=true
LARGE_TRADE_QUOTE_THRESHOLD=1000000
MAX_AGG_TRADE_PAGES_PER_MARKET=30
```

Set `ENABLE_FUTURES_MICROSTRUCTURE=false` to keep only the original price sampling behavior.

## Setup And Verification

After pulling these changes, run:

```bash
npm run db:setup
npm run build
npm run features:backfill-buckets -- 288
npm run collector
```

Useful SQL checks:

```sql
select count(*), max(trade_time) from agg_trades;
select count(*), max(scheduled_at) from book_samples;
select market_id, feature_quality, agg_trade_count, book_sample_count
from market_features
order by updated_at desc
limit 10;
select bucket_start, net_taker_quote, taker_imbalance, book_imbalance_5bps, spread_bps
from market_feature_buckets
order by bucket_start desc
limit 10;
```
