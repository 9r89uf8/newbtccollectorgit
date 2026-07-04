# Chart Panel Data Flow

This document explains, one by one, how the market detail chart collects each signal and how the chart displays it.

Main files involved:

- Collector runtime: `collector/runtime.mjs`
- Raw trade collection: `collector/aggTrades.mjs`
- Raw book-depth collection: `collector/bookSamples.mjs`
- WebSocket top-of-book summaries: `collector/futuresWebSocketSummaries.mjs`
- Per-second trade flow: `collector/marketTradeFlow1s.mjs`
- Per-second microprice buckets: `collector/marketMicropriceBuckets.mjs`
- Positioning samples: `collector/derivativePositionSamples.mjs`
- Market detail queries: `lib/marketDetailData.js`
- Chart prop shaping: `app/markets/[marketId]/page.js`
- ECharts rendering: `app/markets/[marketId]/MarketMicrostructureChart.js`

## Shared Chart Path

1. The collector writes raw rows while a 5 minute BTCUSDT market is open.
2. When the market closes, `closeMarket()` writes derived feature tables used by the detail page.
3. `getMarketDetailData()` reads the market rows from PostgreSQL.
4. `app/markets/[marketId]/page.js` converts database values into plain chart props.
5. `MarketMicrostructureChart.js` maps those props into ECharts series.

Most executed-flow data is post-market derived because aggregate trades are fetched after market close. WebSocket summary rows are collected continuously, then transformed into per-second microprice rows at close and during recent-market refreshes.

## Flow/CVD Chart Panel

### 1. Net Taker

Collection:

- Raw source: Binance Futures REST `/fapi/v1/aggTrades`.
- Collector: `collectFuturesAggregateTradesForMarket()` in `collector/aggTrades.mjs`.
- Timing: fetched after the 5 minute market closes.
- Raw table: `agg_trades`.
- Taker side logic:
  - `buyer_is_maker = true` means the buyer was passive, so the taker side is `sell`.
  - `buyer_is_maker = false` means the buyer crossed the spread, so the taker side is `buy`.
- Notional:
  - `quote_notional = price * quantity`.

Derivation:

- Preferred chart table: `market_trade_flow_1s`.
- Writer: `writeMarketTradeFlow1s()` in `collector/marketTradeFlow1s.mjs`.
- It creates one row per second across the market window.
- For each second:
  - `taker_buy_quote = sum(quote_notional where taker_side = 'buy')`
  - `taker_sell_quote = sum(quote_notional where taker_side = 'sell')`
  - `net_taker_quote = taker_buy_quote - taker_sell_quote`
  - `gross_taker_quote = taker_buy_quote + taker_sell_quote`
- Fallback table for older markets: `market_feature_buckets`, written by `writeMarketFeatureBuckets()`.

Display:

- Query path:
  - `lib/marketDetailData.js` reads `market_trade_flow_1s` into `tradeFlow1s`.
  - It also reads `market_feature_buckets` into `buckets`.
- Chart selection:
  - `MarketMicrostructureChart.js` uses `tradeFlow1s` when rows exist.
  - If no 1-second rows exist, it falls back to `buckets`.
- ECharts mapping:
  - `netTakerData = [time, signedLogNetTaker(net_taker_quote), raw_net_taker_quote]`
  - Displayed as the `Net taker` bar series.
  - Positive bars are green, negative bars are red.
  - The y-axis uses a signed log transform so small and large dollar flows can share the same panel.
  - Tooltip shows the raw dollar value.

### 2. CVD

Collection:

- CVD uses the same aggregate-trade source as net taker.
- Raw input is `agg_trades.quote_notional` grouped by `taker_side`.

Derivation:

- Preferred chart table: `market_trade_flow_1s`.
- Writer: `writeMarketTradeFlow1s()`.
- Per second:
  - `net_taker_quote = taker_buy_quote - taker_sell_quote`
  - `cvd_market_quote = running sum of net_taker_quote inside the current 5 minute market`
  - `cvd_continuous_quote = previous continuous CVD seed + current market running sum`
- Fallback table: `market_cvd_buckets`.
- Fallback writer: `writeMarketCvdBuckets()` in `collector/marketCvdBuckets.mjs`.
- The fallback computes CVD from `market_feature_buckets.net_taker_quote`.

Display:

- Query path:
  - `tradeFlow1s.cvd_market_quote` is read directly from `market_trade_flow_1s`.
  - Fallback `buckets.cvd_market_quote` comes from a join between `market_feature_buckets` and `market_cvd_buckets`.
- Chart selection:
  - Same as net taker: use 1-second flow rows first, fallback to feature/CVD buckets.
- ECharts mapping:
  - `cvdData = [time, signedLogNetTaker(cvd_market_quote), raw_cvd_market_quote]`
  - Displayed as the `CVD` line series.
  - Uses the same signed log flow/CVD y-axis as net taker.
  - Includes a dashed zero line.
  - Tooltip shows raw dollar CVD.

### 3. Micropressure

Collection:

- Raw source: Binance Futures WebSocket `bookTicker`.
- Collector: `startFuturesWebSocketSummaryCollector()` in `collector/futuresWebSocketSummaries.mjs`.
- Raw summary table: `futures_ws_1s_summaries`.
- The WebSocket collector keeps 1-second buckets with:
  - best bid price and quantity
  - best ask price and quantity
  - mid price
  - spread
  - microprice
  - microprice distance from mid
- Microprice formula:
  - `microprice = (best_ask_price * best_bid_qty + best_bid_price * best_ask_qty) / (best_bid_qty + best_ask_qty)`

Derivation:

- Derived table: `market_microprice_buckets`.
- Writer: `writeMarketMicropriceBuckets()` in `collector/marketMicropriceBuckets.mjs`.
- It creates one row per second in the market.
- For each second it uses the latest valid top-of-book row at or before that second.
- A book row is marked stale when the last book update is more than 5 seconds old.
- Lean formula:
  - `microprice_lean = 2 * microprice_bps_from_mid / spread_bps_close`
- Pressure delta:
  - `microprice_delta = microprice_lean * bucket_seconds` for complete or partial buckets.
  - Stale and missing buckets contribute `0`.
- Market pressure:
  - `microprice_pressure_market = running sum of microprice_delta inside the current market`
- Continuous pressure:
  - `microprice_pressure_continuous = prior pressure seed + current market running sum`

Display:

- Query path:
  - `lib/marketDetailData.js` reads `market_microprice_buckets.microprice_pressure_market`.
  - `page.js` passes it as `microprice_pressure_market`.
- ECharts mapping:
  - `micropricePressureData = [time, microprice_pressure_market, microprice_behavior]`
  - Displayed as the `Microprice pressure` line series.
  - Legend label is shortened to `Micropressure`.
  - It is drawn in the Flow/CVD panel on the right y-axis named `Micropressure`.
  - It is not dollar volume. It is an accumulated top-of-book lean value.

## Micro Lean Chart Panel

### 1. EWMA 3s

Collection:

- Uses the same WebSocket top-of-book path as micropressure:
  - `futures_ws_1s_summaries`
  - `market_microprice_buckets`
- The base input is `microprice_lean`.

Derivation:

- Writer: `writeMarketMicropriceBuckets()`.
- Stored column: `market_microprice_buckets.ewma_lean_3s`.
- It is causal and only uses the current row plus prior rows.
- Formula:
  - current valid lean weight: `0.5000`
  - immediately previous row weight, if valid: `0.2500`
  - second immediately previous row weight, if valid: `0.1250`
  - divide by the sum of the weights that have a non-null value
- The current row must have valid lean. Missing, stale, or invalid prior rows are omitted from the weighted denominator.

Display:

- Query path:
  - `lib/marketDetailData.js` reads `ewma_lean_3s`.
  - `page.js` passes it through `chartMicropriceBuckets`.
- ECharts mapping:
  - `micropriceEwma3Data = [time, ewma_lean_3s]`
  - Displayed as the `Microprice EWMA 3s` line series.
  - Legend label is shortened to `EWMA 3s`.
  - It is drawn in the micro lean panel on a fixed `-1` to `+1` y-axis.
  - A dashed zero line marks neutral lean.

### 2. Avg 10s

Collection:

- Uses the same `market_microprice_buckets.microprice_lean` source as EWMA 3s.

Derivation:

- Writer: `writeMarketMicropriceBuckets()`.
- Stored column: `market_microprice_buckets.avg_lean_10s`.
- Formula:
  - trailing average of `microprice_lean`
  - window: current row plus the prior 9 rows
  - only `complete` and `partial` buckets count
- The same writer also stores `persistence_signal`, which the tooltip can show beside the 10-second line.

Display:

- Query path:
  - `lib/marketDetailData.js` reads `avg_lean_10s` and `persistence_signal`.
  - `page.js` passes both into `chartMicropriceBuckets`.
- ECharts mapping:
  - `micropriceAvg10Data = [time, avg_lean_10s, persistence_signal]`
  - Displayed as the `Microprice 10s` dashed line series.
  - Legend label is shortened to `avg 10s`.
  - It shares the micro lean panel's fixed `-1` to `+1` y-axis.

## Imbalance Chart Panel

### 1. Taker Pressure 30s

Collection:

- Raw source: Binance Futures aggregate trades from `/fapi/v1/aggTrades`.
- Raw table: `agg_trades`.
- Derived flow table: `market_trade_flow_1s`.
- Fallback table: `market_feature_buckets`.
- The database also stores rolling 30-second values in `market_trade_flow_1s`, but the chart recomputes its own display series so it can use either 1-second rows or fallback feature buckets.

Display derivation:

- Function: `buildTrailingTakerPressureData()` in `MarketMicrostructureChart.js`.
- Input rows:
  - `net_taker_quote`
  - `gross_taker_quote` from `market_trade_flow_1s`
  - fallback `total_volume_quote` from `market_feature_buckets`
- For each chart point:
  - use rows ending within the trailing 30 seconds
  - `rollingNet = sum(net_taker_quote)`
  - `rollingGross = sum(gross_taker_quote)`
  - `volumeFloor = max(median positive gross row, 50000)`
  - `denominator = max(rollingGross, volumeFloor)`
  - `pressure = rollingNet / denominator`
  - clamp pressure to `-1` through `+1`

Display:

- ECharts mapping:
  - `takerPressure30sData = [time, pressure, rollingNet, rollingGross]`
  - Displayed as the `Taker pressure 30s` line series.
  - It uses the imbalance panel's `-1` to `+1` y-axis.
  - Tooltip shows pressure plus trailing 30-second net and gross dollar flow.

### 2. Book Imbalance

Collection:

- Raw source: Binance Futures REST `/fapi/v1/depth`.
- Collector: `collectFuturesBookSample()` in `collector/bookSamples.mjs`.
- Raw table: `book_samples`.
- Sampling:
  - normal market sampling follows the 5-second collector cadence
  - the final ramp follows the 1-second collector cadence
- Depth derivation:
  - mid price is `(best_bid_price + best_ask_price) / 2`
  - bid depth is summed within 5, 10, and 25 bps below mid
  - ask depth is summed within 5, 10, and 25 bps above mid
- Book imbalance formula:
  - `book_imbalance_Xbps = (bid_depth_Xbps - ask_depth_Xbps) / (bid_depth_Xbps + ask_depth_Xbps)`

Derivation:

- Chart bucket table: `market_feature_buckets`.
- Writer: `writeMarketFeatureBuckets()` in `collector/marketFeatureBuckets.mjs`.
- It carries the sampled `book_imbalance_5bps`, `book_imbalance_10bps`, and `book_imbalance_25bps` values forward into bucket rows.
- The chart uses the 5 bps version.

Display:

- Query path:
  - `lib/marketDetailData.js` reads `market_feature_buckets.book_imbalance_5bps`.
  - `page.js` passes it as `book_imbalance_5bps`.
- ECharts mapping:
  - `bookImbalanceData = [time, book_imbalance_5bps]`
  - Displayed as the `Book imbalance` line series.
  - It shares the imbalance panel's `-1` to `+1` y-axis with taker pressure.

## OI Change Chart Panel

### 1. Open Interest

Collection:

- Raw sources:
  - Binance Futures REST `/fapi/v1/premiumIndex`
  - Binance Futures REST `/fapi/v1/openInterest`
- Collector: `collectFuturesPositionSample()` in `collector/derivativePositionSamples.mjs`.
- Raw table: `derivative_position_samples`.
- Sampling:
  - collected every 5 seconds when futures positioning is enabled
  - collection happens on scheduled times where the market offset is divisible by 5 seconds
- Open-interest fields:
  - `open_interest_base` comes from Binance `openInterest`
  - `open_interest_quote = open_interest_base * mark_price`

Display:

- Query path:
  - `lib/marketDetailData.js` reads `derivative_position_samples.open_interest_quote` for the market window.
  - `page.js` passes it as `positionSeries`.
- Chart derivation:
  - `openInterestBase = first non-null open_interest_quote in the market`
  - `open_interest_change = open_interest_quote - openInterestBase`
- ECharts mapping:
  - `openInterestData = [time, open_interest_change, absolute_open_interest_quote]`
  - Displayed as the `Open interest` line series.
  - Legend label is shortened to `OI change`.
  - It uses the OI panel's left y-axis named `OI change`.
  - Tooltip shows both the absolute open interest and the change from the first market sample.

### 2. Mark/Index

Collection:

- Raw source: Binance Futures REST `/fapi/v1/premiumIndex`.
- Collector: `collectFuturesPositionSample()` in `collector/derivativePositionSamples.mjs`.
- Raw table: `derivative_position_samples`.
- Stored raw fields:
  - `mark_price`
  - `index_price`
- Stored chart field:
  - `premium_bps = ((mark_price - index_price) / index_price) * 10000`
- In this app, `premium_bps` is the mark/index basis. It is separate from Binance `/futures/data/basis`.

Display:

- Query path:
  - `lib/marketDetailData.js` reads `derivative_position_samples.premium_bps`.
  - `page.js` passes it as `positionSeries.premium_bps`.
- ECharts mapping:
  - `premiumData = [time, premium_bps]`
  - Displayed as the `Mark/index basis` line series.
  - It uses the OI panel's right y-axis named `Mark/index`.
  - A dashed zero line marks where mark and index are equal.
- The same panel also draws `BTC on OI` from the Binance Futures price series as context, but the mark/index line itself is the basis in bps.
