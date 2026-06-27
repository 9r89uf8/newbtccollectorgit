Your current setup already has the right core: Binance BTCUSDT spot/futures price samples, futures agg trades, futures top-20 depth-derived book metrics, mark/index/funding/OI context, 5-minute labels, behavior labels, classifications, and 76 intra-market feature buckets per complete 5-minute market.

For **less-than-1-minute BTC prediction**, the biggest missing pieces are:

1. **sub-minute forward labels**,
2. **order-book change dynamics**,
3. **liquidation events**,
4. **spot-vs-futures and cross-exchange lead/lag**,
5. **better data-quality/timestamp metadata**.

Binance is a reasonable anchor. CoinGecko’s 2025 centralized-exchange volume report had Binance at **39.2% of top-10 spot volume**, far ahead of Bybit, OKX, and Coinbase, so using Binance first is sensible. But for very short BTC moves, I would still add **one independent venue** later, not many, because you want to detect whether Binance is leading the market or just reacting to another venue. ([CoinGecko][1])

## Highest-priority missing data

### 1. Forward labels at 1s, 5s, 10s, 15s, 30s, and 60s

This is the most important thing, and it does **not** require a new raw feed.

Right now your system is organized around 5-minute markets. That is useful for classifying regimes, but your stated goal is things like:

> “when this happens, BTC tends to go down in the next minute”

So each timestamp bucket needs forward-looking outcome labels.

Add a table like:

```text
market_forward_labels
```

Fields:

```text
symbol
source
bucket_start
horizon_seconds        -- 1, 5, 10, 15, 30, 60
price_now
future_price
forward_return_bps
future_max_up_bps
future_max_down_bps
future_close_location
hit_up_threshold
hit_down_threshold
hit_up_before_down
direction_label        -- up / down / flat
flip_label             -- no_flip / flip_up / flip_down
quality
```

For short horizons, avoid labeling every tiny move as “up” or “down.” Use a threshold based on noise, for example:

```text
up   = forward_return_bps >= max(1.0 bps, 2x recent spread_bps)
down = forward_return_bps <= -max(1.0 bps, 2x recent spread_bps)
flat = otherwise
```

Without this, you will mostly learn random micro-noise.

### 2. Full-window 1-second buckets, not only final-ramp 1-second buckets

Your current design samples every 5 seconds for most of the 5-minute window, then every 1 second only during the final ramp. That makes sense for 5-minute close labeling, but it is coarse for sub-minute prediction. The file says a complete 5-minute market currently creates 56 five-second buckets and 20 one-second final-ramp buckets.

For your goal, I would make **1-second buckets for the entire market**:

```text
300 one-second buckets per 5-minute market
```

Each bucket should include:

```text
open_price
high_price
low_price
close_price
vwap
return_bps
realized_vol_bps
trade_count
agg_trade_count
taker_buy_quote
taker_sell_quote
net_taker_quote
taker_imbalance
large_trade_count
max_trade_quote
spread_bps
book_imbalance_5bps
book_imbalance_10bps
book_imbalance_25bps
bid_depth_5bps
ask_depth_5bps
bid_depth_change_5bps
ask_depth_change_5bps
microprice_bps_from_mid
price_impact_after_bucket_bps
```

This gives you rows where you can ask:

```text
At time t, given the last 1s / 5s / 15s of behavior, what happened by t+10s, t+30s, or t+60s?
```

That is much closer to your actual research question.

## Highest-value new raw feeds

### 3. Binance futures order-book deltas, not just REST snapshots

Your current top-20 book snapshots are useful, but for sub-minute movement, the missing information is often **how the book changes between snapshots**: orders getting pulled, reloaded, swept, or stacked.

Binance USD-M futures has diff depth WebSocket streams with book updates at 250ms, 500ms, or 100ms where available. ([Binance Developer Center][2]) Binance also documents a real-time individual symbol book ticker stream for best bid/ask price and quantity. ([Binance Developer Center][3])

Do **not** store every raw depth update forever at first. That may explode storage.

Better approach:

```text
Use WebSocket depth/bookTicker internally
Maintain a local book
Store 1-second derived summaries
Optionally keep raw depth deltas for only 24-72 hours for debugging
```

Add derived 1-second fields like:

```text
best_bid_update_count
best_ask_update_count
best_bid_price_move_count
best_ask_price_move_count
bid_depth_added_5bps
bid_depth_removed_5bps
ask_depth_added_5bps
ask_depth_removed_5bps
bid_depth_pull_ratio
ask_depth_pull_ratio
bid_replenishment_after_sell
ask_replenishment_after_buy
book_pressure_score
microprice
microprice_bps_from_mid
```

This helps detect patterns such as:

```text
heavy market buying + ask depth keeps reloading + price does not move up
= buy pressure absorbed
= possible short-term down/flip signal
```

or:

```text
ask depth disappears + taker buys accelerate + spread widens
= liquidity vacuum upward
= possible short-term continuation
```

### 4. Liquidation events

For BTC futures, liquidation clusters can matter a lot at short horizons. Binance has a futures liquidation stream, but note an important limitation: for each symbol, it pushes only the **largest liquidation order within a 1000ms interval** if one exists. ([Binance Developer Center][4])

Add:

```text
liquidation_events
liquidation_buckets_1s
```

Fields:

```text
event_time
symbol
side                 -- BUY or SELL liquidation order
price
avg_price
quantity
quote_notional
order_status
bucket_start
liquidation_count
buy_liq_quote
sell_liq_quote
max_liq_quote
net_liq_quote
```

Pattern examples this can support:

```text
price falling + sell liquidations spike + OI drops
= long squeeze / deleveraging
```

```text
price rising + buy liquidations spike + OI drops
= short squeeze
```

Liquidation data is high signal and not huge storage compared with full order-book deltas.

### 5. Binance spot microstructure, not just Binance spot last price

You currently collect Binance spot last price, but most of your detailed flow/book data is futures-side.

For short-term BTC moves, you want to know:

```text
Is spot leading futures?
Is futures pushing ahead of spot?
Is perp premium expanding because of leverage?
Is spot confirming the move?
```

I would add **Binance spot BTCUSDT agg trades and top-of-book/depth summaries**, but again store them as 1-second summaries unless you specifically need raw spot trades.

Add fields like:

```text
spot_taker_buy_quote_1s
spot_taker_sell_quote_1s
spot_net_taker_quote_1s
spot_book_imbalance_5bps
spot_spread_bps
spot_mid_return_bps
futures_minus_spot_basis_bps
spot_leads_futures_5s_return
futures_leads_spot_5s_return
```

This lets you detect:

```text
spot buying leads, futures follows
= organic spot-led move
```

versus:

```text
futures pumps, spot lags, premium expands
= leverage-led move, higher fade risk
```

### 6. One outside exchange feed

Do this after improving Binance sub-minute labels and book dynamics.

I would not add five exchanges. Add **one** independent reference venue first:

```text
Option A: Coinbase BTC-USD spot
Option B: Bybit BTCUSDT perpetual
```

Coinbase is useful as an independent USD spot venue; its Advanced Trade WebSocket market-data feed provides real-time updates for market orders, trades, order books, and market movement. ([Coinbase Developer Docs][5]) Bybit is useful if you want another major derivatives venue; its WebSocket order book provides snapshot/delta updates, and its liquidation stream pushes liquidation data at 500ms frequency. ([Bybit Exchange][6]) ([Bybit Exchange][7])

For minimal storage, store only:

```text
exchange
symbol
bucket_start
mid_price
best_bid
best_ask
spread_bps
return_1s_bps
return_5s_bps
taker_buy_quote
taker_sell_quote
net_taker_quote
book_imbalance_5bps
liquidation_quote   -- if derivative venue
```

Then create cross-exchange features:

```text
coinbase_spot_return_1s - binance_futures_return_1s
bybit_perp_return_1s - binance_futures_return_1s
binance_futures_basis_vs_coinbase_bps
cross_exchange_divergence_bps
cross_exchange_convergence_next_10s
```

This is how you find patterns like:

```text
Coinbase spot jumps first, Binance futures follows within 5-15 seconds
```

or:

```text
Binance perp spikes alone, spot does not confirm, move fades
```

## Useful but lower-priority data

### 7. Long/short ratio and top-trader positioning

You already collect current open interest, funding, mark/index, and premium.  The missing slow-moving positioning context is:

```text
global long/short account ratio
top trader long/short account ratio
top trader long/short position ratio
open interest history at official 5m period
```

Binance offers global long/short ratio with 5m as the shortest period, and the docs say only the latest 30 days are available, so collect it if you want historical research later. ([Binance Developer Center][8]) Binance also offers top-trader account ratio and top-trader position ratio endpoints. ([Binance Developer Center][9]) ([Binance Developer Center][10])

This probably will not predict the next 10 seconds directly, but it can help classify regimes:

```text
crowded long market
crowded short market
OI rising with price
OI rising against price
OI dropping during squeeze
```

### 8. Mark price stream at 1 second

You already sample mark/index/premium/funding/open interest on a 5-second cadence. Binance’s mark price stream can update every 3 seconds or 1 second. ([Binance Developer Center][11])

I would not rush this unless you see your 5-second premium data missing fast dislocations. But if you add WebSockets anyway, adding 1-second mark/index/premium is cheap.

## Data I would avoid for now

I would **not** collect these yet:

```text
Twitter/social sentiment
news headlines
on-chain whale transfers
mempool data
ETF flows
macro indicators
hundreds of altcoin pairs
full raw order book forever
```

Those may help longer-horizon analysis, but they are usually too slow, too noisy, or too expensive for “next 1-60 seconds” BTC movement.

The exception is a simple event flag table for major scheduled events:

```text
CPI release
FOMC decision
Fed press conference
major Binance maintenance/outage
major ETF market open/close windows
```

But do not make this a priority until the microstructure dataset is solid.

## The clean collection plan

I would implement in this order.

### Phase 1: No new exchange feeds

Use what you already collect.

Add:

```text
1s buckets for all timestamps
forward labels at 1s / 5s / 10s / 15s / 30s / 60s
rolling features over last 3s / 5s / 10s / 30s / 60s
```

Derived features:

```text
net_taker_quote_1s
net_taker_quote_5s
net_taker_quote_acceleration
taker_imbalance_zscore
trade_count_zscore
large_trade_recent
vwap_deviation_bps
return_1s_bps
return_5s_bps
realized_vol_10s
book_imbalance_change_5bps
spread_widening
depth_thinning
absorption_score
```

This is the cheapest and probably most important phase.

### Phase 2: Add Binance futures WebSocket book dynamics

Add:

```text
depth/bookTicker WebSocket ingestion
local order book
1-second order-book delta summaries
sequence-gap detection
latency tracking
```

Do not store massive raw depth forever.

### Phase 3: Add liquidations

Add:

```text
Binance futures forceOrder stream
1-second liquidation buckets
squeeze/deleveraging labels
```

### Phase 4: Add one outside venue

Start with either:

```text
Coinbase BTC-USD spot
```

or:

```text
Bybit BTCUSDT perpetual
```

Do not add both at first. Pick Coinbase if you want independent spot confirmation. Pick Bybit if you want another derivatives/liquidation venue.

## The most important pattern classes to target

Given your goal, I would explicitly build features for these:

```text
1. continuation after aggressive buying/selling
2. absorption
3. liquidity vacuum
4. spot-led move
5. futures-led fakeout
6. short squeeze
7. long squeeze
8. OI-backed trend
9. OI-drop deleveraging
10. spread-widening instability
```

Example rule-style patterns:

```text
net_taker_buy_quote_5s high
+ ask_depth_5bps falling
+ microprice above mid
+ forward_return_30s positive
= possible upside continuation
```

```text
net_taker_buy_quote_10s high
+ price_return_10s flat
+ ask_depth_replenishment high
= buy pressure absorbed
= possible downside flip
```

```text
futures_return_5s positive
+ spot_return_5s flat
+ premium_bps rising
+ OI rising
= leverage-led move
= possible fade risk
```

```text
price_return_10s negative
+ sell_liquidation_quote high
+ OI dropping
= long squeeze / deleveraging
```

## My recommendation

Do **not** add lots of random data yet.

Add these first:

```text
1. Sub-minute forward labels
2. Full 1-second buckets across the whole 5-minute market
3. Binance futures order-book delta summaries
4. Binance futures liquidations
5. Binance spot trade/book summaries
6. One outside exchange only after that
```

The biggest conceptual change is this:

```text
Keep 5-minute markets as the regime container.
Use 1-second buckets as the prediction rows.
Use 1s/5s/10s/15s/30s/60s forward labels as the outcomes.
```

That structure will let you test the exact kind of statements you want to make: “when X and Y happen, BTC tends to move up/down within the next minute.”

[1]: https://www.coingecko.com/research/publications/centralized-crypto-exchanges-market-share "Market Share of Centralized Crypto Exchanges, by Trading Volume | CoinGecko"
[2]: https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Diff-Book-Depth-Streams "Diff Book Depth Streams | Binance Open Platform"
[3]: https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Individual-Symbol-Book-Ticker-Streams "Individual Symbol Book Ticker Streams | Binance Open Platform"
[4]: https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Liquidation-Order-Streams "Liquidation Order Streams | Binance Open Platform"
[5]: https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/guides/websocket "Advanced Trade WebSockets. Setup, Authentication, and Subscriptions - Coinbase Developer Documentation"
[6]: https://bybit-exchange.github.io/docs/v5/websocket/public/orderbook "Orderbook | Bybit API Documentation"
[7]: https://bybit-exchange.github.io/docs/v5/websocket/public/all-liquidation "All Liquidation | Bybit API Documentation"
[8]: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Long-Short-Ratio "Long Short Ratio | Binance Open Platform"
[9]: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Top-Long-Short-Account-Ratio "Top Trader Long Short Account Ratio | Binance Open Platform"
[10]: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Top-Trader-Long-Short-Ratio "Top Trader Long Short Position Ratio | Binance Open Platform"
[11]: https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Mark-Price-Stream "Mark Price Stream | Binance Open Platform"
