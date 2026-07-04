# LLM Market Chart Data Inventory

This document inventories the data needed to feed one 5 minute BTCUSDT market to an LLM using the Binance Futures BTC price plus the same series displayed in the market detail chart panel.

It complements `docs/chart-panel-data-flow.md`, which explains chart behavior. This file focuses on collection cadence, PostgreSQL storage, and data size.

## Measurement Notes

The size numbers below use a read-only PostgreSQL snapshot from the latest closed market available when this document was written:

```text
market_id: 2026-07-04T22:40:00Z_BTCUSDT
window:    2026-07-04T22:40:00Z through 2026-07-04T22:45:00Z
status:    closed
```

`avg row bytes` means `pg_column_size(row)` for rows in that market. It is useful for comparing payload/storage weight, but it excludes indexes and some table overhead. The table-size section later includes total relation size with indexes and TOAST.

The chart props use only a subset of each database row, so a compact JSON payload for an LLM can be much smaller than the full database row sizes.

## Shared Cadences

Most REST samples use the market schedule:

| Market offset | Frequency | Sample type | Included in chart window |
| --- | --- | --- | --- |
| `0s` through `275s` | Every 5 seconds | `normal` | Yes |
| `280s` through `299s` | Every 1 second | `final_ramp` | Yes |
| `300s` | Once at close boundary | `close` | Price and positioning charts include it |

Expected rows for one complete 5 minute market:

| Data family | Expected rows |
| --- | ---: |
| Binance Futures price chart rows | 77 |
| Polymarket Chainlink BTC sampled rows | 77 |
| Polymarket probability rows | 76 |
| Binance depth/book samples used by feature buckets | 76 |
| Futures positioning chart rows | 61 |
| WebSocket one-second summary rows | Up to 300 |
| Microprice derived rows | 300 |
| Trade-flow derived rows | 300 |
| Feature/CVD mixed-width bucket rows | 76 |

Positioning has 61 chart rows because the detail query includes the exact close-boundary sample. Positioning feature rollups normally use 60 pre-close rows.

## Chart Series Inventory

| Chart panel | Plotted series | Collected how often | Saved how | Rows and measured size for snapshot | LLM payload note |
| --- | --- | --- | --- | --- | --- |
| BTC price references | `BTC price` | Binance Futures REST `/fapi/v2/ticker/price` on the shared REST cadence. | `price_samples` where `source = 'binance_futures'`; global table keyed by `scheduled_at`, `source`, `symbol`, `sample_type`. | 77 rows, avg 128.0 B, about 9.6 KiB of row data. | Include `{time, price}`. This is the primary Binance BTC path for the chart. |
| BTC price references | `Chainlink BTC` | Polymarket RTDS `crypto_prices_chainlink` WebSocket keeps the latest BTC/USD tick in memory; collector writes the latest tick on the shared REST cadence. | `chainlink_btc_price_samples` keyed by `source`, `market_id`, `scheduled_at`. Gamma open/settlement prices are also stored in `polymarket_5m_btc_markets.price_to_beat` and `end_price`. | 77 sampled rows, avg 571.8 B, about 43.0 KiB. Metadata: 1 row, avg 2963.0 B. | Optional if the LLM needs Polymarket settlement context. Include `{time, price, quality, tick_age_ms}` plus Gamma open/close prices. |
| BTC price references | `Market Up`, `Market Down` | Polymarket CLOB midpoint request on the pre-close cadence only: every 5s through `275s`, every 1s from `280s` through `299s`; no close row. | `polymarket_probability_samples` keyed by `source`, `market_id`, `scheduled_at`; stores Up and Down together plus normalized probabilities and raw midpoint response. | 76 rows, avg 545.6 B, about 40.5 KiB. | Include `{time, up_probability, down_probability, quality}` if market pricing matters. |
| Flow/CVD | `Net taker` | Binance Futures REST `/fapi/v1/aggTrades` after market close; one or more pages capped by `MAX_AGG_TRADE_PAGES_PER_MARKET`. | Raw rows in `agg_trades`; chart prefers derived `market_trade_flow_1s.net_taker_quote`. Older fallback is `market_feature_buckets.net_taker_quote`. | Raw: 1393 rows, avg 135.2 B, about 184.0 KiB. Derived: 300 rows, avg 332.3 B, about 97.4 KiB. | Prefer derived 1s rows: `{time, taker_buy_quote, taker_sell_quote, net_taker_quote, gross_taker_quote}`. Raw trades are high volume and usually not needed. |
| Flow/CVD | `CVD` | Same aggregate-trade collection as Net taker. | `market_trade_flow_1s.cvd_market_quote` and `cvd_continuous_quote`; fallback `market_cvd_buckets` joined to `market_feature_buckets`. | Derived 1s table shares the 300 rows above. Fallback CVD buckets: 76 rows, avg 294.4 B, about 21.8 KiB. | Include `cvd_market_quote` for market-local interpretation. Include `cvd_continuous_quote` only if cross-market continuity matters. |
| Flow/CVD | `Microprice pressure` | Binance Futures WebSocket `@bookTicker` is summarized continuously into UTC-aligned 1s buckets. Derived after close and during recent-market refresh. | Raw summaries in `futures_ws_1s_summaries`; chart uses `market_microprice_buckets.microprice_pressure_market`. | WebSocket summaries: 300 rows, avg 394.4 B, about 115.5 KiB. Microprice buckets: 300 rows, avg 388.4 B, about 113.8 KiB. | Include `{time, microprice_lean, microprice_pressure_market, microprice_behavior}` from `market_microprice_buckets`. |
| Flow/CVD | `Net liquidation` | Binance Futures WebSocket `@forceOrder`, summarized into the same 1s WebSocket bucket as book ticker. | `futures_ws_1s_summaries.liquidation_buy_quote`, `liquidation_sell_quote`, `liquidation_net_quote`, `liquidation_count`. Raw liquidation events are not stored. | Shares the 300 WebSocket summary rows above. | Include `{time, liquidation_net_quote, liquidation_count, liquidation_max_quote}` when liquidation context matters. |
| Micro lean | `Microprice EWMA 3s` | Derived from WebSocket top-of-book summaries. No separate feed. | `market_microprice_buckets.ewma_lean_3s`. | Shares the 300 microprice rows above. | Include with raw lean for short-horizon top-of-book pressure. |
| Micro lean | `Microprice 10s` | Derived from WebSocket top-of-book summaries. No separate feed. | `market_microprice_buckets.avg_lean_10s` and `persistence_signal`. | Shares the 300 microprice rows above. | Include `{avg_lean_10s, persistence_signal}` for persistence rather than single-second noise. |
| Imbalance | `Taker pressure 30s` | Display transform from aggregate-trade-derived flow rows. No separate collection. | Not stored as its own column for the chart. The chart computes it from `market_trade_flow_1s`; fallback uses `market_feature_buckets`. | No additional rows. It reuses the 300 trade-flow rows or the 76 feature buckets. | For LLMs, either include precomputed values in the payload or include `rolling_net_30s`, `rolling_gross_30s`, and `rolling_imbalance_30s` from `market_trade_flow_1s`. |
| Imbalance | `Book imbalance` | Binance Futures REST `/fapi/v1/depth?limit=100` on the shared REST cadence. Feature rows exclude the close boundary. | Raw metrics in `book_samples`; chart uses `market_feature_buckets.book_imbalance_5bps`. | Raw book: 76 rows, avg 242.1 B, about 18.0 KiB. Feature buckets: 76 rows, avg 324.3 B, about 24.1 KiB. | Include `book_imbalance_5bps` from feature buckets. Raw depth levels are not stored. |
| Imbalance | `Spread` | Same Binance Futures depth samples as Book imbalance. | Raw `book_samples.spread_bps`; chart uses `market_feature_buckets.spread_bps`. | Shares the raw book and feature bucket rows above. | Include `spread_bps` from feature buckets, or `spread_bps_avg/max` from WebSocket summaries for 1s spread behavior. |
| OI change | `Open interest` | Binance Futures REST `/fapi/v1/premiumIndex` and `/fapi/v1/openInterest` every 5 seconds, including 5-second aligned final-ramp and close timestamps. | `derivative_position_samples.open_interest_base` and `open_interest_quote`; one market rollup in `market_position_features`. | Position samples: 61 rows, avg 192.5 B, about 11.5 KiB. Position feature row: 1 row, avg 402.0 B. | Include `{time, open_interest_quote}` and compute change from the first sample, matching the chart. |
| OI change | `Mark/index basis` | Same positioning sample as Open interest. | `derivative_position_samples.premium_bps`; this is mark/index basis, not Binance `/futures/data/basis`. | Shares the 61 positioning rows above. | Include `{time, premium_bps}`. |
| OI change | `BTC on OI` | Reuses Binance Futures price samples. No separate collection. | Reuses `price_samples` chart rows. | No additional rows beyond the 77 Binance Futures price rows. | Include only once in the LLM payload and let the consumer reuse it in both panels. |

## Raw Versus Derived Storage

For LLM input, derived chart tables are usually the right level:

| Use case | Prefer | Avoid unless needed |
| --- | --- | --- |
| Price path | `price_samples` subset `{time, price}` | Full `price_samples` row with latency and source fields repeated each point |
| Executed flow and CVD | `market_trade_flow_1s` | Full `agg_trades` firehose |
| Book pressure | `market_microprice_buckets` | Raw WebSocket messages, which are not stored |
| Book imbalance and spread | `market_feature_buckets` | `book_samples` unless you need bid/ask depth bands |
| Liquidations and 1s book health | `futures_ws_1s_summaries` subset | Full summary row if only net liquidation is needed |
| Positioning | `derivative_position_samples` subset | Full `market_position_features` if you need time series |
| Polymarket context | `polymarket_probability_samples` subset plus Gamma open/close metadata | Full `raw_response` or `raw_gamma` unless debugging |

## Table Storage Snapshot

These are total PostgreSQL relation sizes for the relevant tables at the same snapshot. `Total size` includes heap, indexes, and TOAST. `Avg total bytes/row` is approximate because it uses PostgreSQL estimated live row counts.

| Table | Total size | Estimated rows | Avg total bytes/row |
| --- | ---: | ---: | ---: |
| `agg_trades` | 2555.0 MiB | 10,272,463 | 261 B |
| `futures_ws_1s_summaries` | 335.1 MiB | 604,065 | 582 B |
| `market_microprice_buckets` | 327.1 MiB | 418,500 | 820 B |
| `polymarket_probability_samples` | 128.5 MiB | 145,703 | 925 B |
| `price_samples` | 101.2 MiB | 305,904 | 347 B |
| `market_feature_buckets` | 85.1 MiB | 152,892 | 583 B |
| `book_samples` | 68.3 MiB | 145,997 | 490 B |
| `market_cvd_buckets` | 67.4 MiB | 129,201 | 547 B |
| `market_trade_flow_1s` | 64.2 MiB | 111,900 | 602 B |
| `derivative_position_samples` | 48.3 MiB | 120,735 | 420 B |
| `chainlink_btc_price_samples` | 19.4 MiB | 22,953 | 887 B |
| `polymarket_5m_btc_markets` | 7.7 MiB | 1,981 | 4065 B |
| `market_labels` | 1.2 MiB | 4,028 | 301 B |
| `market_position_features` | 1.1 MiB | 2,014 | 565 B |

## Suggested Compact LLM Payload

A compact market payload can omit raw database rows and send normalized arrays:

```text
market:
  id, symbol, start_time, end_time, status

prices:
  binance_futures: [{t, price}]
  chainlink_btc: optional [{t, price, quality}]
  polymarket_settlement: optional {price_to_beat, end_price, winning_outcome}

probabilities:
  optional [{t, up, down, quality}]

flow_1s:
  [{t, net, gross, buy, sell, cvd_market, rolling_net_30s, rolling_gross_30s, rolling_imbalance_30s}]

microprice_1s:
  [{t, lean, ewma_3s, avg_10s, pressure_market, persistence_signal, behavior}]

liquidity:
  feature_buckets: [{t, book_imbalance_5bps, spread_bps}]
  websocket_1s: optional [{t, spread_avg, spread_max, book_updates, net_liquidation}]

positioning:
  [{t, open_interest_quote, premium_bps}]
```

That shape keeps the LLM close to what the chart displays while avoiding the largest raw table, `agg_trades`, unless the prompt specifically needs trade-by-trade detail.
