# Market Start Collection

This document explains what the collector does when one 5 minute BTCUSDT market ends and the next one starts, with special attention to the first seconds of each new market.

Relevant implementation files:

- `collector/runtime.mjs`
- `collector/time.mjs`
- `collector/priceSamples.mjs`
- `collector/bookSamples.mjs`
- `collector/derivativePositionSamples.mjs`
- `collector/aggTrades.mjs`
- `collector/futuresWebSocketSummaries.mjs`
- `collector/polymarketSamples.mjs`
- `collector/chainlinkBtcSamples.mjs`

## Market Windows

Markets are fixed 5 minute UTC windows. The market id is deterministic:

```text
<UTC market start ISO timestamp>_<symbol>
```

Example:

```text
2026-07-05T14:00:00Z_BTCUSDT
```

That market covers:

```text
start_time = 2026-07-05T14:00:00Z
end_time   = 2026-07-05T14:05:00Z
```

The next market starts exactly where the previous market ends:

```text
14:05:00 closes the 14:00-14:05 market
14:05:00 opens the 14:05-14:10 market
```

## Scheduled Sampling Cadence

The collector schedules samples inside each market as follows:

| Window offset | Frequency | Sample type |
| --- | --- | --- |
| `0s` through `275s` | Every 5 seconds | `normal` |
| `280s` through `299s` | Every 1 second | `final_ramp` |
| `300s` | Once at the exact close/open boundary | `close` |

Binance spot/futures price labels use samples from `start_time` through `end_time`, including the close boundary. Feature tables generally use `start_time <= timestamp < end_time`, so the exact close timestamp becomes the first timestamp of the next market's feature window.

## What Happens At The Boundary

At the close/open boundary, the collector treats one timestamp as both the old market close and the new market open.

For Binance price data:

1. The collector writes `price_samples` for the previous market at `scheduled_at = previous.end_time` with `sample_type = close`.
2. Because the next market starts at the same timestamp, that same price row is also the next market's opening price when labels are computed.
3. The collector does not need to write a duplicate `normal` Binance price row for the next market at the same timestamp.

For Binance book and positioning data:

1. The close-boundary REST depth sample is written to `book_samples`.
2. The close-boundary mark/index/open-interest sample is written to `derivative_position_samples` when positioning is enabled.
3. These rows are timestamped globally, so the same boundary timestamp can be used as the previous market close context and the next market's first pre-close feature timestamp.

For Polymarket Chainlink BTC reference data:

1. The collector keeps the latest BTC/USD Chainlink RTDS tick in memory.
2. At the boundary, it writes that same latest tick twice:
   - previous market: `sample_type = close`
   - next market: `sample_type = normal`
3. These rows are separate because `chainlink_btc_price_samples` is keyed by `market_id`.

For Polymarket Up/Down CLOB probabilities:

1. The previous market does not get a close probability sample.
2. The collector tries to write the next market's opening probability sample at the boundary.
3. That opening sample uses the next market's Gamma/CLOB token ids and writes to `polymarket_probability_samples` with `sample_type = normal`.
4. If that opening sample is missing or partial, a Polymarket-only retry loop keeps trying the same opening timestamp for up to 20 seconds.

## Polymarket Metadata Prefetch

Polymarket 5 minute BTC markets are discovered with deterministic slugs:

```text
btc-updown-5m-<utc_start_epoch_seconds>
```

The collector prefetches Gamma metadata before the next market starts. By default, it starts looking up the next market during the final minute before the boundary:

```text
POLYMARKET_METADATA_PREFETCH_LEAD_MS=60000
```

Prefetch is best-effort. It can cache the next market's Up and Down CLOB token ids before the market opens, which allows the boundary sample to succeed immediately. If Polymarket has not exposed the market or token ids yet, the prefetch fails quietly and the collector tries again on later scheduled samples.

When the next market is inside the prefetch lead window, the collector also samples the upcoming market's CLOB midpoints before the market starts and stores those rows as `sample_type = preopen`. These rows answer: "what was Polymarket pricing for the upcoming market before the BTC 5 minute window began?" They are not used as Binance labels and they are not the Chainlink `price_to_beat`.

## Why Some Polymarket Probability Series Start Late

Some Polymarket 5 minute Up/Down markets do not expose usable Up/Down probabilities immediately at the UTC start boundary. In practice, the CLOB midpoint data can appear 10 to 15 seconds after the market has already started.

When that happens:

1. The collector still creates or upserts the local `markets` row at the exact UTC start.
2. Binance spot, Binance futures, book depth, positioning, WebSocket summaries, and Chainlink RTDS sampling continue on the normal schedule.
3. The Polymarket probability request at `0s` can fail because Gamma metadata or CLOB token ids are missing.
4. The request at `5s` can also fail or return missing midpoint values.
5. The regular 5 second cadence may therefore first see complete data at `10s`, `15s`, or whichever scheduled timestamp first returns both Up and Down midpoints.

The collector now also starts a Polymarket-only opening retry loop for the first 20 seconds of the market. That retry keeps trying to fill the `scheduled_at = market.start_time` row without repeating Binance collection. If a complete Up/Down midpoint pair becomes available late, the row is written with `availability_status = delayed_open` and `data_delay_ms` showing how late the data was collected.

This does not recover a true `0s` midpoint if Polymarket had no usable book at `0s`. It records the first available opening midpoint while making the delay explicit. The market can still have complete Binance labels while its Polymarket probability coverage shows a delayed open.

## What Happens After A Market Ends

After the boundary samples are written, the collector schedules close processing for the market that just ended. Close processing runs separately so the collector can keep moving into the new market.

Close processing does the following:

1. Fetches Binance Futures aggregate trades for the closed window.
2. Writes Binance spot and futures `market_labels`.
3. Refreshes Polymarket Gamma metadata for the closed market, including `price_to_beat`, `end_price`, and `winning_outcome` when available.
4. Writes market-level futures features, per-timestamp buckets, CVD buckets, one-second trade-flow rows, positioning features, behavior labels, classifications, microprice buckets, and forward labels when those modules are enabled.
5. Refreshes recent Polymarket settlements because Gamma settlement fields can arrive after the market end time.

The market is marked `closed` only when the Binance spot and Binance futures labels are complete and the market was not already marked incomplete. Polymarket probability late-start behavior is tracked in the probability sample table and coverage stats, but it does not by itself change `markets.status` to `incomplete`.

## Collector Restart Or Delay At Market Start

On startup, the collector calculates the current 5 minute market. If the collector started after that market's exact start timestamp, it marks the current market `incomplete` and records a `collector_restart_gap` error. It still collects the remaining timestamps until the market closes.

There is also a short boundary close grace path. If the collector enters a new market within 15 seconds of the boundary and the previous market's close price samples are not present yet, it attempts to collect the previous market close sample immediately. That boundary collection also attempts the next market's opening Polymarket probability sample and Chainlink RTDS sample.

## Source-by-source Start Behavior

| Source | At exact market start | If source is late |
| --- | --- | --- |
| Binance spot last price | Boundary close row is reused as next open. | Missing exact open makes Binance label partial or incomplete. |
| Binance futures last price | Boundary close row is reused as next open. | Missing exact open makes Binance label partial or incomplete. |
| Binance Futures depth | Boundary depth row is used as the new market's first feature timestamp. | Missing rows reduce feature quality. |
| Binance Futures positioning | Boundary mark/index/open-interest row is used when enabled. | Missing rows reduce positioning feature quality. |
| Binance Futures WebSocket summaries | Continuous 1-second buckets keep writing while the process is running. | A stale WebSocket can mark the current market incomplete. |
| Binance Futures aggregate trades | Not collected at market start; fetched after the market closes. | Page-limit or request failures make derived trade-flow rows partial. |
| Polymarket Chainlink BTC RTDS | Latest tick is written for both previous close and next open. | Missing or stale latest tick sets row quality to `missing` or `partial`. |
| Polymarket Up/Down probabilities | Collector samples upcoming-market CLOB midpoints before start as `preopen`, then tries to write a `0s` opening sample and retries that opening row for up to 20 seconds. | If the opening quote arrives late, the row is marked `delayed_open` with `data_delay_ms`; otherwise missing attempts remain `missing`. |
| Polymarket Gamma settlement metadata | Prefetched before start when possible and refreshed after close. | Official `price_to_beat`, `end_price`, and outcome can appear after close and are refreshed later. |

## Practical Reading

If a market's Polymarket probability chart starts late, check:

```sql
select
  scheduled_at,
  collected_at,
  quality,
  availability_status,
  data_delay_ms,
  up_probability,
  down_probability
from polymarket_probability_samples
where market_id = '<market_id>'
order by scheduled_at;
```

If the first row is later than `markets.start_time`, Polymarket did not provide usable CLOB probability data to the collector at the beginning of that market. Compare this with Binance price samples:

```sql
select scheduled_at, source, sample_type, price
from price_samples
where symbol = 'BTCUSDT'
  and scheduled_at between '<market_start>' and '<market_end>'
order by scheduled_at, source;
```

That comparison should show whether the issue is Polymarket-only or a broader collector timing gap.
