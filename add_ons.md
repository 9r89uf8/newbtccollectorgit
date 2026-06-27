# Add Ons: Futures Microstructure V1

This repo now implements the first two data additions:

1. Binance Futures aggregate trades for aggressive buy/sell flow.
2. Binance Futures top-20 order book depth for available liquidity.

The implementation is intentionally split across small collector modules instead of one large collector file.

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

## Data Tables

The schema adds three tables:

```text
agg_trades
book_samples
market_features
```

`agg_trades` stores raw futures aggregate trades with one row per Binance aggregate trade id.

`book_samples` stores derived top-20 book metrics at scheduled sample times. It does not store full order book snapshots.

`market_features` stores one futures feature row per market.

## Why REST First Instead Of WebSockets

The original add-on notes described Binance websocket streams. Those are still valid for a later lower-latency collector, but the implemented V1 uses REST endpoints because:

- it fits the existing scheduled collector loop
- it avoids adding a websocket dependency
- it keeps the collector easy to deploy under the current Node systemd service
- it still records the requested market-level features

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

## Taker Flow

Binance aggregate trades include `m`, which means the buyer was the maker.

The collector maps it as:

```text
m = false -> buyer was taker/aggressive -> taker_side = buy
m = true  -> seller was taker/aggressive -> taker_side = sell
```

For each aggregate trade:

```text
quote_notional = price * quantity
```

Market features include:

```text
total_volume_quote
taker_buy_quote
taker_sell_quote
net_taker_quote
taker_imbalance
agg_trade_count
large_trade_count
max_trade_quote
```

`LARGE_TRADE_QUOTE_THRESHOLD` controls the `large_trade_count` cutoff. The default is `1000000` quote notional.

## Book Liquidity

The collector fetches futures top-20 depth at each scheduled sample time and stores derived features:

```text
best_bid_price
best_bid_qty
best_ask_price
best_ask_qty
mid_price
spread_bps
bid_depth_5bps
ask_depth_5bps
book_imbalance_5bps
bid_depth_10bps
ask_depth_10bps
book_imbalance_10bps
bid_depth_25bps
ask_depth_25bps
book_imbalance_25bps
```

Depth is quote notional:

```text
price * quantity
```

Book imbalance is:

```text
(bid_depth - ask_depth) / (bid_depth + ask_depth)
```

## No-Leakage Rule

Labels use the close-boundary price sample:

```sql
scheduled_at >= market.start_time
and scheduled_at <= market.end_time
```

Features do not use the close boundary:

```sql
scheduled_at >= market.start_time
and scheduled_at < market.end_time
```

That is important because the close price at `market.end_time` is the label. Feature inputs should explain the market before that label, not include the label boundary itself.

## Env Settings

```text
ENABLE_FUTURES_MICROSTRUCTURE=true
LARGE_TRADE_QUOTE_THRESHOLD=1000000
MAX_AGG_TRADE_PAGES_PER_MARKET=30
```

Set `ENABLE_FUTURES_MICROSTRUCTURE=false` to keep only the original price sampling behavior.

`MAX_AGG_TRADE_PAGES_PER_MARKET` protects the collector from unbounded pagination in extreme trade volume. Each page can hold up to 1000 aggregate trades.

## Setup And Verification

After pulling these changes, run:

```bash
npm run db:setup
npm run build
npm run collector
```

The dashboard shows a futures microstructure panel once `market_features` rows exist.

Useful SQL checks:

```sql
select count(*), max(trade_time) from agg_trades;
select count(*), max(scheduled_at) from book_samples;
select market_id, source, feature_quality, agg_trade_count, book_sample_count
from market_features
order by updated_at desc
limit 10;
```

## Later Upgrade Path

A websocket collector can replace the REST collectors later if sub-second raw streaming becomes necessary. Keep the same tables and feature calculations unless there is a specific reason to change the data model.
