# Polymarket 5 Minute BTC Collector

This repo collects Polymarket BTC Up/Down 5 minute probabilities as a read-only data family attached to the existing UTC `markets` rows.

The implementation is plain JavaScript in `collector/polymarketSamples.mjs`. It does not use Polymarket WebSockets and does not collect Polymarket's live BTC price feed.

## Source Endpoints

Market metadata is discovered through Gamma by deterministic slug:

```text
GET https://gamma-api.polymarket.com/markets/slug/btc-updown-5m-<utc_start_epoch_seconds>
```

Token probabilities are sampled from CLOB midpoint prices:

```text
POST https://clob.polymarket.com/midpoints
```

The midpoint response is keyed by CLOB token id, so the collector first parses Gamma `outcomes` and `clobTokenIds` to map `Up` and `Down` to token ids.

## Window Alignment

The slug epoch is the source of truth for the 5 minute UTC market window. Gamma fields like `startDate` and `startDateIso` are Polymarket creation/series metadata and are not used as the collector's market start time.

For example:

```text
market start: 2026-06-27T02:25:00Z
slug:         btc-updown-5m-1782527100
market id:    2026-06-27T02:25:00Z_BTCUSDT
```

## Sampling Schedule

Polymarket probability samples use the same pre-close schedule as the existing price/book collector:

```text
0s through 275s:    every 5 seconds, sample_type normal
280s through 299s:  every 1 second, sample_type final_ramp
300s:               no probability sample
```

Expected complete probability count:

```text
56 normal samples
20 final_ramp samples
76 total samples
```

A sample at exactly `end_time` is intentionally skipped because the market may be closed, stale, or resolving at that boundary.

## Tables

`polymarket_5m_btc_markets` stores Gamma metadata for each existing 5 minute BTC market:

- `source`, `market_id`, `symbol`, `slug`
- Polymarket ids: `polymarket_market_id`, `condition_id`, `up_token_id`, `down_token_id`
- Collector window: `start_time`, `end_time`
- Gamma dates: `gamma_start_date`, `gamma_end_date`
- Settlement metadata: `price_to_beat`, `end_price`, `winning_outcome`
- Status flags: `active`, `closed`, `accepting_orders`, `automatically_resolved`, `gamma_status`
- Full `raw_gamma` JSON for reparsing

`polymarket_probability_samples` stores one row per scheduled timestamp with both outcomes:

- `up_probability`, `down_probability`
- `probability_sum`
- `up_probability_normalized`, `down_probability_normalized`
- `quality` as `complete`, `partial`, or `missing`
- Full raw CLOB midpoint response

One paired row is used instead of one row per token because model features usually need the Up/Down pair at the same timestamp.

## Completion Semantics

Polymarket collection quality is separate from `markets.status`. The existing market status remains based on the Binance price-label completeness rules.

For Polymarket:

- A probability series is complete when 76 expected rows exist and the midpoint rows are complete.
- Settlement metadata is refreshed separately because Gamma can expose `closed`, `priceToBeat`, and `finalPrice` after `market.end_time`.
- `price_to_beat` and `end_price` are optional until Gamma exposes them, usually under nested event metadata such as `events.eventMetadata.priceToBeat` and `events.eventMetadata.finalPrice`.

## Configuration

Polymarket collection is enabled by default:

```bash
ENABLE_POLYMARKET_BTC_5M=true
POLYMARKET_TIMEOUT_MS=4000
```

Disable it with:

```bash
ENABLE_POLYMARKET_BTC_5M=false
```

Sources:

- https://docs.polymarket.com/api-reference/markets/get-market-by-slug
- https://docs.polymarket.com/api-reference/market-data/get-midpoint-prices-request-body
- https://docs.polymarket.com/api-reference/rate-limits
