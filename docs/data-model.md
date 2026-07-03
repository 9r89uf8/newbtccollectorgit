# Data Collection And Markets

This document describes what the collector records and how 5 minute BTCUSDT markets are represented in PostgreSQL.

## Raw Data Sources

The collector tracks one symbol by default:

```text
BTCUSDT
```

It records these data families.

| Family | Source | Instrument type | Endpoint | Stored data |
| --- | --- | --- | --- | --- |
| Last price | `binance_spot` | `spot` | `/api/v3/ticker/price` | Latest traded price samples. |
| Last price | `binance_futures` | `futures` | `/fapi/v2/ticker/price` | Latest traded price samples. |
| Aggregate trades | `binance_futures` | `futures` | `/fapi/v1/aggTrades` | Raw aggregate trades for each completed market. |
| Top-100 book depth | `binance_futures` | `futures` | `/fapi/v1/depth?limit=100` | Derived top-of-book and depth metrics at each scheduled sample time. |
| Futures positioning | `binance_futures` | `futures` | `/fapi/v1/premiumIndex`, `/fapi/v1/openInterest` | Mark/index price, mark/index basis, funding, and current open interest on a 5 second cadence. |
| Futures basis | `binance_futures` | `futures` | `/futures/data/basis` | Binance 5 minute basis, basis rate, futures price, and index price for `PERPETUAL` by default. |
| Prediction market probabilities | `polymarket_clob_midpoints` | `prediction_market` | Gamma `/markets/slug/{slug}`, CLOB `/midpoints` | 5 minute BTC Up/Down market metadata and paired Up/Down midpoint probabilities. |
| Top-of-book updates | `binance_futures_ws` | `futures` | WebSocket `@bookTicker` | One-second top-of-book summaries. Raw messages are not stored. |
| Liquidation events | `binance_futures_ws` | `futures` | WebSocket `@forceOrder` | One-second liquidation notional summaries. Raw events are not stored. |

The spot and futures last-price samples are written to `price_samples`. Futures aggregate trades are written to `agg_trades`. Futures book-depth metrics are written to `book_samples`. Futures positioning samples are written to `derivative_position_samples`. Binance basis rows are written to `futures_basis_samples`. Binance Futures WebSocket updates are folded into `futures_ws_1s_summaries`. Polymarket Gamma market metadata is written to `polymarket_5m_btc_markets`, and CLOB midpoint probability samples are written to `polymarket_probability_samples`.

## Sampling Schedule

Every market is a 5 minute UTC window.

| Window offset | Frequency | Sample type |
| --- | --- | --- |
| `0s` through `275s` | Every 5 seconds | `normal` |
| `280s` through `299s` | Every 1 second | `final_ramp` |
| `300s` | Once at the exact close boundary | `close` |

Ideal last-price samples per source per complete market:

```text
56 normal samples
20 final_ramp samples
1 close sample
77 total samples per source
154 total samples across spot + futures
```

Book depth is sampled on the same schedule. WebSocket summaries are independent of this REST schedule and are stored as UTC-aligned 1-second buckets while the collector is running. Market-level feature calculations intentionally use only samples where:

```sql
scheduled_at >= market.start_time
and scheduled_at < market.end_time
```

That excludes the exact close boundary from explanatory features, because the close price at `end_time` is the label. The expected book sample count for a complete feature row is therefore:

```text
76 samples per market
```

## What A Market Is

A market is a fixed UTC time window:

```text
[start_time, end_time]
```

The collector creates one market every 5 minutes for the configured symbol. Example:

```text
id:         2026-06-27T02:25:00Z_BTCUSDT
symbol:     BTCUSDT
start_time: 2026-06-27T02:25:00Z
end_time:   2026-06-27T02:30:00Z
status:     open
```

Market ids are deterministic:

```text
<UTC market start ISO timestamp>_<symbol>
```

## Boundary Samples

Price samples are stored globally by timestamp, not physically inside a market.

The close timestamp of one market is also the open timestamp of the next market:

```text
02:25:00 closes the 02:20-02:25 market
02:25:00 opens the 02:25-02:30 market
```

This avoids duplicate data. A sample at the boundary can be used as both the previous market close and the next market open.

Label queries include the exact close sample:

```sql
scheduled_at >= market.start_time
and scheduled_at <= market.end_time
```

Feature queries exclude the exact close sample:

```sql
scheduled_at >= market.start_time
and scheduled_at < market.end_time
```


## Polymarket BTC 5 Minute Probabilities

Polymarket markets are discovered by deterministic slug:

```text
btc-updown-5m-<utc_start_epoch_seconds>
```

The slug epoch defines the 5 minute UTC window. Gamma `startDate` and `startDateIso` are treated as Polymarket creation/series metadata, not as the collector market start time.

Probability samples use the same pre-close cadence as the existing collector and do not include a close-boundary sample:

| Window offset | Frequency | Sample type |
| --- | --- | --- |
| `0s` through `275s` | Every 5 seconds | `normal` |
| `280s` through `299s` | Every 1 second | `final_ramp` |

Expected Polymarket probability samples per complete market:

```text
56 normal samples
20 final_ramp samples
76 total probability samples
```

Each row stores the Up and Down CLOB midpoint prices together, plus normalized probabilities and the raw probability sum. Settlement metadata such as `price_to_beat`, `end_price`, and `winning_outcome` is refreshed from Gamma after close and can arrive later than `market.end_time`.
## Market Status

The `markets.status` field can be:

| Status | Meaning |
| --- | --- |
| `open` | The current market window is still collecting. |
| `closed` | The market finished and all source labels were complete. |
| `incomplete` | The market has a known collection gap, or it finished with at least one source label partial or missing. |

When the collector starts, it checks for older `open` or active `incomplete` markets whose `end_time` has passed and attempts to close them. If the collector starts or restarts after the current market window has already begun, it marks that current market `incomplete` immediately and records a `collector_restart_gap` error. The market can still keep collecting until `end_time`; `closed_at` is set only when final close processing runs.

## Market Labels

After a market closes, the collector creates one label per price source in `market_labels`.

| Label field | Meaning |
| --- | --- |
| `open_price` | First sample price in the market window for that source. |
| `close_price` | Last sample price in the market window for that source. |
| `return_pct` | `(close_price - open_price) / open_price * 100`. |
| `direction` | `up`, `down`, or `flat`. |
| `sample_count` | Number of price samples found in the market window for that source. |
| `quality` | `complete`, `partial`, or `missing`. |

A source label is `complete` when:

```text
sample_count >= 76
first sample timestamp equals market start_time
last sample timestamp equals market end_time
```

The ideal dense schedule has 77 samples. Labels accept 76 when the exact open and close boundary samples exist, because the collector can spend the first few seconds of a new window closing and materializing the previous window. In that case the market outcome label is still valid even if one interior price sample is absent.

Otherwise it is `partial` if open and close samples exist, or `missing` if no usable samples exist.

## Aggregate Trades

The collector fetches Binance Futures aggregate trades after a market reaches its close boundary. Each trade row is stored in `agg_trades` with:

| Field | Meaning |
| --- | --- |
| `agg_trade_id` | Binance aggregate trade id. |
| `trade_time` | Exchange trade timestamp. |
| `price` | Trade price. |
| `quantity` | Base asset quantity. |
| `quote_notional` | `price * quantity`. |
| `buyer_is_maker` | Binance `m` field. |
| `taker_side` | `buy` when `buyer_is_maker = false`, otherwise `sell`. |
| `first_trade_id`, `last_trade_id` | Binance trade id range for the aggregate trade. |

The taker-side rule is:

```text
buyer_is_maker = false -> buyer was taker/aggressive -> taker_side = buy
buyer_is_maker = true  -> seller was taker/aggressive -> taker_side = sell
```

The collector pages through `/fapi/v1/aggTrades` and caps pages per market with `MAX_AGG_TRADE_PAGES_PER_MARKET`.

## Book Samples

At each scheduled sample time, the collector fetches Binance Futures top-100 depth and stores derived features in `book_samples`:

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

Depth is stored as quote notional. For example:

```text
bid_depth_5bps = sum(price * quantity) for bids within 5 bps below mid
ask_depth_5bps = sum(price * quantity) for asks within 5 bps above mid
```

Book imbalance is:

```text
(bid_depth - ask_depth) / (bid_depth + ask_depth)
```

## Futures Positioning Samples

The collector can also sample Binance Futures positioning context with REST calls, without adding a WebSocket dependency. These calls run only on the 5 second cadence inside each market, including 5 second aligned final-ramp timestamps. The 1 second final-ramp price/book samples do not all trigger positioning calls.

Each row in `derivative_position_samples` stores:

```text
mark_price
index_price
premium_bps
funding_rate
interest_rate
next_funding_time
open_interest_base
open_interest_quote
mark_exchange_time
open_interest_exchange_time
mark_latency_ms
open_interest_latency_ms
```

`premium_bps` is the legacy column name for mark/index basis: `(mark_price - index_price) / index_price * 10000`. It is not Binance `/futures/data/basis`.

Market-level positioning features are materialized in `market_position_features` using samples where:

```sql
scheduled_at >= market.start_time
and scheduled_at < market.end_time
```

A complete positioning feature row expects 60 pre-close samples per 5 minute market. Derived fields include:

```text
mark_price_start
mark_price_end
premium_bps_start
premium_bps_end
premium_bps_min
premium_bps_max
premium_bps_avg
premium_bps_change
funding_rate
minutes_to_funding
open_interest_quote_start
open_interest_quote_end
open_interest_change_quote
open_interest_change_pct
basis_time
basis
basis_rate
basis_bps
basis_bps_previous
basis_bps_change
basis_quality
```

## Futures Basis Samples

At market close, the collector fetches Binance `/futures/data/basis` with `pair=BTCUSDT`, `contractType=PERPETUAL`, and `period=5m` by default. The endpoint is an interval/historical feed, not a 5 second live stream.

Rows are stored in `futures_basis_samples` and rolled into `market_position_features`. `basis_bps` is calculated as `basis_rate * 10000`. `basis_bps_change` compares the selected market basis row with the previous stored basis row when available.

## WebSocket Summary Samples

When futures microstructure collection is enabled, the collector can also subscribe to Binance Futures WebSocket streams for:

```text
<symbol>@bookTicker
<symbol>@forceOrder
```

The collector uses these messages only as transient input. It does not store raw WebSocket messages, raw liquidation events, or debug copies. It aggregates finalized UTC-aligned 1-second rows into `futures_ws_1s_summaries`.

Book-ticker summary fields include:

```text
book_ticker_update_count
bid_price_move_count
ask_price_move_count
mid_price_move_count
best_bid_price_open / close / min / max
best_bid_qty_open / close / min / max
best_ask_price_open / close / min / max
best_ask_qty_open / close / min / max
mid_price_open / close / low / high
mid_return_bps
spread_bps_open / close / avg / max
microprice_open / close
microprice_bps_from_mid_close
avg_event_lag_ms
max_event_lag_ms
```

Liquidation stream messages are summarized into the same 1-second row:

```text
liquidation_count
liquidation_buy_quote
liquidation_sell_quote
liquidation_net_quote
liquidation_max_quote
```

The WebSocket summary table is the short-horizon prediction row source. It captures 1-second top-of-book movement and liquidation pressure without creating a raw market-data firehose.

If no WebSocket message arrives for 20 seconds by default, the collector marks the current market `incomplete`, records a `websocket_no_messages` error, and closes any open WebSocket so the reconnect loop can create a fresh connection. This threshold is controlled by `FUTURES_WS_STALE_MS`.

## Forward Labels

Forward labels are derived from `futures_ws_1s_summaries`; they do not add a new feed. For each 1-second summary row, the collector writes outcome labels for these horizons:

```text
1s, 5s, 10s, 15s, 30s, 60s
```

Each `market_forward_labels` row stores:

```text
price_now
future_price
forward_return_bps
future_max_up_bps
future_max_down_bps
threshold_bps
hit_up_threshold
hit_down_threshold
hit_up_before_down
direction_label
path_sample_count
quality
```

The default direction threshold is:

```text
max(1.0 bps, 2x current spread_bps)
```

That keeps tiny quoted-market noise from being labeled as meaningful up/down movement. Complete labels require the future price row and enough 1-second path samples for the horizon.

## Microprice Buckets

Microprice buckets are derived from `futures_ws_1s_summaries`; they do not add a raw feed. For each 5 minute market the collector materializes one expected row per UTC second:

```text
300 rows per complete market
bucket_start >= market.start_time
bucket_start < market.end_time
```

Each row carries the latest recent valid WebSocket top-of-book state and marks whether the second had a direct book update, a carried-forward recent book, stale book state, or no usable book state.

Core fields include:

```text
source_summary_quality
book_ticker_update_count
seconds_since_book_update
mid_price
spread_bps_close / avg / max
microprice
microprice_bps_from_mid
microprice_lean
microprice_delta
microprice_pressure_market
microprice_pressure_continuous
avg_lean_10s / 30s
up_lean_share_10s / 30s
down_lean_share_10s / 30s
valid_sample_count_10s / 30s
spread_stable_10s / 30s
mid_change_10s_bps / 30s_bps
price_stalled_10s / 30s
lean_direction
persistence_signal
flip_signal
microprice_behavior
bucket_quality
```

Normalized lean is:

```text
microprice_lean = 2 * microprice_bps_from_mid / spread_bps_close
```

With the current top-of-book formula this is equivalent to:

```text
(best_bid_qty - best_ask_qty) / (best_bid_qty + best_ask_qty)
```

Interpretation:

```text
positive = bid side heavier = upward top-of-book pressure
negative = ask side heavier = downward top-of-book pressure
```

Bucket quality can be:

| Quality | Meaning |
| --- | --- |
| `complete` | The second had a direct valid book-ticker summary. |
| `partial` | The row uses a recent carried-forward valid book state. |
| `stale` | The latest valid book state is older than the signal staleness threshold. |
| `missing` | No usable book state was available. |

Persistence labels require enough valid samples in the 10s or 30s rolling window, same-direction lean share of at least 70%, and stable spread. Stale and missing seconds do not contribute to `microprice_delta` or persistence counts.

`microprice_pressure_market` resets at each 5 minute market. `microprice_pressure_continuous` keeps running across markets for the same symbol and WebSocket source. As with continuous CVD, backfilling older microprice buckets requires recomputing later continuous rows.

## Market Features

After labels are written, the collector materializes one futures feature row per market in `market_features`.

Trade-flow fields include:

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

Book-liquidity fields include:

```text
book_sample_count
avg_spread_bps
max_spread_bps
avg_book_imbalance_5bps
min_book_imbalance_5bps
max_book_imbalance_5bps
avg_bid_depth_5bps
avg_ask_depth_5bps
min_bid_depth_5bps
min_ask_depth_5bps
avg_ask_bid_depth_ratio
```

`feature_quality` is:

| Quality | Meaning |
| --- | --- |
| `complete` | Trades exist and at least 76 pre-close book samples exist. |
| `partial` | Some feature inputs exist, but the row is not complete. |
| `missing` | No trade or book inputs were found. |


## Behavior Labels And Classification

After the futures labels and microstructure features are written, the collector derives one futures behavior label in `market_behavior_labels`. This table is derived from existing futures price samples and aggregate trades. It does not add another raw feed.

Behavior label fields include:

```text
high_price
low_price
high_time
low_time
range_bps
close_location
max_up_bps_from_open
max_down_bps_from_open
realized_vol_bps
trade_vwap
vwap_deviation_bps
largest_1s_return_bps
largest_5s_return_bps
price_reversal_count
magnitude_class
shape_class
close_location_class
volatility_class
```

The collector then writes one rule-based row to `market_classifications`. The first version can classify markets as:

```text
quiet_range
range_up
range_down
trend_up
trend_down
spike_fade
reversal_up
reversal_down
buy_pressure_absorbed
sell_pressure_absorbed
long_build
short_build
short_squeeze
long_squeeze
deleveraging
unclassified
```

Classification rows include `primary_class`, `secondary_tags`, `confidence`, `feature_version`, and `reasons`. They are derived and can be recomputed if thresholds or labels change.

## Timestamp Feature Buckets

The collector also materializes per-timestamp interval summaries in `market_feature_buckets`.

Each bucket starts at a pre-close book sample timestamp and ends at the next book sample timestamp, or at `market.end_time` for the final pre-close bucket:

```sql
trade_time >= bucket_start
and trade_time < bucket_end
```

For a complete 5 minute market this creates 76 bucket rows:

```text
56 five-second buckets
20 one-second final-ramp buckets
```

Each bucket stores:

```text
bucket_start
bucket_end
bucket_seconds
open_price
close_price
return_pct
direction
net_taker_quote
taker_imbalance
agg_trade_count
spread_bps
book_imbalance_5bps
bid_depth_5bps
ask_depth_5bps
```

The bucket table is derived from raw `agg_trades`, `book_samples`, and `price_samples`. Keep the raw tables because bucket logic can be recomputed later if the analysis window or feature definitions change.

### Dashboard Taker Pressure Line

`market_feature_buckets.taker_imbalance` is the raw per-bucket trade-flow ratio stored for analysis and recomputation. The dashboard imbalance panel does not plot that raw ratio as the main purple line because low-volume one-second buckets can jump between `-1` and `+1`.

For display, the dashboard derives a trailing 30-second taker pressure line from the same bucket rows:

```text
rolling_net_30s = sum(net_taker_quote) over the trailing 30 seconds
rolling_gross_30s = sum(total_volume_quote) over the trailing 30 seconds
volume_floor = max(median positive bucket total_volume_quote, 50000)

taker_pressure_30s = rolling_net_30s / max(rolling_gross_30s, volume_floor)
```

The calculation uses completed bucket end timestamps and only includes past bucket data, so it is safe for live-style charting and does not use future data. The plotted value is clamped to the same `-1` to `+1` range as raw imbalance, and the tooltip shows the trailing 30-second net and gross quote volume.

This is currently a dashboard display transform, not a stored database column.
## Cumulative Volume Delta Buckets

After `market_feature_buckets` is written, the collector derives one `market_cvd_buckets` row for each timestamp bucket. This table does not add a raw feed; it uses the existing bucket trade-flow delta:

```text
delta_quote = market_feature_buckets.net_taker_quote
            = taker_buy_quote - taker_sell_quote
```

CVD continuously adds that signed delta into a running total:

```text
cvd = previous_cvd + delta_quote
```

Each CVD bucket stores:

```text
delta_quote
cvd_market_quote
cvd_continuous_quote
cvd_change_5b
price_change_5b_bps
cvd_direction
price_direction
cvd_price_behavior
cvd_divergence_5b
```

`cvd_market_quote` resets at the start of each 5 minute market. `cvd_continuous_quote` keeps running across markets for the same symbol and source. When an older bucket is backfilled or recomputed, later continuous CVD rows should be recomputed because they depend on the changed delta history.

Because futures aggregate trades are fetched after market close, this CVD is currently a post-market derived feature. A live CVD chart would require adding a Binance Futures trade stream such as aggTrade/trade.

## Main Tables

| Table | Purpose |
| --- | --- |
| `markets` | Defines 5 minute BTCUSDT windows. |
| `price_samples` | Stores spot and futures latest-price samples. |
| `agg_trades` | Stores raw Binance Futures aggregate trades. |
| `book_samples` | Stores derived Binance Futures top-100 book metrics. |
| `market_labels` | Stores open/close labels per market and source. |
| `market_features` | Stores futures trade-flow and book-liquidity features per market. |
| `derivative_position_samples` | Stores compact Binance Futures mark/index/funding/open-interest samples. `premium_bps` is mark/index basis. |
| `futures_basis_samples` | Stores Binance `/futures/data/basis` interval basis rows. |
| `futures_ws_1s_summaries` | Stores Binance Futures WebSocket book-ticker and liquidation summaries by 1-second bucket. |
| `market_position_features` | Stores per-market positioning rollups derived from positioning and basis samples. |
| `market_behavior_labels` | Stores richer per-market futures behavior labels derived from existing samples and trades. |
| `market_classifications` | Stores rule-based market classes, tags, confidence, version, and reasons. |
| `market_feature_buckets` | Stores per-timestamp futures feature summaries inside each market. |
| `market_cvd_buckets` | Stores per-timestamp cumulative volume delta derived from `market_feature_buckets`. |
| `market_microprice_buckets` | Stores per-second top-of-book microprice pressure derived from `futures_ws_1s_summaries`. |
| `market_forward_labels` | Stores 1s/5s/10s/15s/30s/60s outcome labels derived from WebSocket summaries. |
| `polymarket_5m_btc_markets` | Stores Polymarket Gamma metadata for each matching 5 minute BTC Up/Down market. |
| `polymarket_probability_samples` | Stores paired Up/Down CLOB midpoint probabilities at each pre-close sample timestamp. |
| `collector_heartbeats` | Stores latest collector status. |
| `collection_errors` | Stores request and collection failures. |

## Operational Assumptions

- All market timestamps are UTC.
- The configured symbol defaults to `BTCUSDT`.
- Plain PostgreSQL is supported. TimescaleDB is optional.
- `price_samples` and `book_samples` can become Timescale hypertables when TimescaleDB is installed.
- Aggregate trades are kept as a plain PostgreSQL table because the uniqueness rule is `(source, symbol, agg_trade_id)`.
- Futures microstructure collection is enabled by default and can be disabled with `ENABLE_FUTURES_MICROSTRUCTURE=false`.
- Futures positioning and basis collection are enabled by default and can be disabled with `ENABLE_FUTURES_POSITIONING=false`.
- Futures WebSocket summary collection is enabled by default and can be disabled with `ENABLE_FUTURES_WEBSOCKET_SUMMARIES=false`.
- Polymarket BTC 5 minute probability collection is enabled by default and can be disabled with `ENABLE_POLYMARKET_BTC_5M=false`.
- WebSocket storage is summary-only. Raw WebSocket messages and raw liquidation events are intentionally not stored.
