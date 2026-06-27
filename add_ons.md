You already have a good **Binance futures microstructure core**: sampled futures/spot prices, futures agg trades, taker side, and top-20 futures book summaries. The biggest gaps are not “more BTC price samples.” The biggest gaps are **positioning, leverage stress, perp-vs-spot context, cross-venue confirmation, and richer intra-window labels**.

Binance is still a reasonable primary venue. CoinGecko’s May 2026 exchange-share report had Binance first among centralized spot exchanges, with Bybit, MEXC, Gate, Crypto.com, Bitget, OKX, Coinbase, HTX, and Upbit behind it for 2025 spot volume share. CoinGlass’s Q1 2026 report also shows Binance leading in derivatives volume, open interest, and BTC futures depth, with OKX and Bybit the most relevant second venues depending on whether you care more about futures depth or spot depth. ([CoinGecko][1])

## Highest-value missing data

### 1. Futures positioning: open interest, funding, mark/index price, basis

This is the first thing I would add.

Right now you know:

```text
price moved
taker buy/sell flow moved
book imbalance changed
```

But you do **not** yet know whether the move came with:

```text
new leverage entering
old leverage closing
perp premium expanding
perp premium collapsing
funding pressure
mark/index dislocation
```

Binance already exposes these directly. The mark-price endpoint returns mark price, index price, latest funding rate, interest rate, and next funding time. The funding-rate-history endpoint returns funding rate, funding time, and mark price. Binance also exposes present open interest and 5-minute open-interest history. ([Binance Developers][2])

Add a table like:

```text
derivative_position_samples
- source
- symbol
- scheduled_at
- exchange_time
- mark_price
- index_price
- last_price
- premium_bps = (mark_price - index_price) / index_price * 10000
- basis_bps
- funding_rate
- next_funding_time
- open_interest_base
- open_interest_quote
- oi_change_5m
- oi_change_pct_5m
```

Then create features like:

```text
avg_premium_bps
max_premium_bps
premium_change_bps
funding_rate
minutes_to_funding
open_interest_start
open_interest_end
open_interest_change_quote
open_interest_change_pct
oi_volume_ratio
return_per_oi_change
```

This is extremely useful for market classification:

| Pattern       |      Price |   OI | Taker flow | Interpretation                                 |
| ------------- | ---------: | ---: | ---------: | ---------------------------------------------- |
| Long build    |         Up |   Up |  Buy-heavy | New longs chasing.                             |
| Short build   |       Down |   Up | Sell-heavy | New shorts pressing.                           |
| Short squeeze |         Up | Down |  Buy-heavy | Shorts closing or liquidating.                 |
| Long squeeze  |       Down | Down | Sell-heavy | Longs closing or liquidating.                  |
| Absorption    |       Flat |   Up |  One-sided | Aggressive flow absorbed by passive liquidity. |
| Deleveraging  | Large move | Down |       High | Positions closing, market de-risking.          |

One important operational detail: Binance’s open-interest-history endpoint says only the latest one month is available, and some trader-ratio endpoints say latest 30 days only. If you want this for research, collect and store it continuously rather than assuming you can backfill it later. ([Binance Developers][3])

## 2. Liquidations / forced-order events

Liquidations are one of the cleanest ways to distinguish a normal directional move from a squeeze or cascade.

Binance has liquidation order streams for a symbol and for all symbols. The symbol stream is `<symbol>@forceOrder`, and the all-market stream is `!forceOrder@arr`. Binance describes these as force-liquidation snapshots, with only the largest liquidation order per symbol within a 1000 ms interval pushed. ([Binance Developers][4])

Add:

```text
liquidation_events
- source
- symbol
- event_time
- transaction_time
- side
- price
- quantity
- quote_notional
- average_price if available
- order_status
- raw_payload
```

Then derive per 5-minute market:

```text
long_liquidation_quote
short_liquidation_quote
net_liquidation_quote
liquidation_count
max_liquidation_quote
liquidation_quote / total_volume_quote
liquidation_quote / book_depth_25bps
liquidation_cluster_seconds
liquidations_in_final_60s
```

Useful classification examples:

```text
price down + sell taker flow + long liquidations + OI down
= long squeeze / forced deleveraging

price up + buy taker flow + short liquidations + OI down
= short squeeze

liquidations high but price stops moving
= possible exhaustion / absorption
```

Caveat: the public stream is a snapshot feed, not necessarily every individual liquidation. It is still valuable for regime classification, but you should store it as “observed liquidation pressure,” not absolute liquidation truth.

## 3. Spot trades and spot order book, not just spot last price

You are collecting spot last-price samples, but your rich microstructure is futures-only. That means you cannot yet tell whether a move is:

```text
spot-led
futures-led
perp-only leverage move
cross-market confirmed move
```

Add Binance spot:

```text
spot_agg_trades
spot_book_samples
spot_market_features
spot_feature_buckets
```

Use the same taker-side, volume, spread, depth, and imbalance features you already compute for futures.

Then derive:

```text
spot_return_pct
futures_return_pct
futures_minus_spot_return_bps
spot_taker_imbalance
futures_taker_imbalance
spot_futures_taker_imbalance_diff
spot_volume_quote
futures_volume_quote
futures_volume / spot_volume
spot_book_imbalance_5bps
futures_book_imbalance_5bps
```

This unlocks very useful market classes:

| Class                        | Description                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------ |
| Spot-led trend               | Spot moves first, futures follows. Usually healthier than pure perp pressure.  |
| Futures-led squeeze          | Futures premium, taker flow, OI, and liquidations dominate.                    |
| Cross-market confirmed trend | Spot and futures move together with aligned flow.                              |
| Perp dislocation             | Futures moves without spot confirmation; often mean-reversion or squeeze risk. |

## 4. More complete book data: deeper snapshots or raw book updates

Your top-20 futures depth metrics are useful, but they are also lossy. You are storing derived metrics only, so you cannot later recompute different depth bands, book slopes, queue changes, or order-flow imbalance.

Binance’s futures REST order book supports valid depth limits up to 1000 levels, not just 20. Binance also has partial book depth streams for top 5/10/20 and diff book depth streams at 250 ms, 500 ms, or 100 ms update speeds. ([Binance Developers][5])

At minimum, add either:

```text
book_levels_snapshots
- source
- symbol
- scheduled_at
- exchange_time
- side
- level_index
- price
- quantity
- quote_notional
```

or store raw JSON alongside your current derived row:

```text
book_samples.raw_bids_json
book_samples.raw_asks_json
book_samples.last_update_id
```

Then you can later compute:

```text
depth_50bps
depth_100bps
depth_slope_bid
depth_slope_ask
distance_to_1m_notional_bid
distance_to_1m_notional_ask
microprice
weighted_mid_price
book_pressure_score
liquidity_gap_above
liquidity_gap_below
```

For deeper pattern work, add a WebSocket-based local book later:

```text
book_depth_updates
- source
- symbol
- event_time
- transaction_time
- first_update_id
- final_update_id
- previous_final_update_id
- side
- price
- quantity
```

That allows true order-flow imbalance:

```text
bid_size_added
bid_size_removed
ask_size_added
ask_size_removed
ofi = bid_added - bid_removed - ask_added + ask_removed
```

This is different from book imbalance. Book imbalance tells you what is sitting there. OFI tells you how liquidity is changing.

## 5. Better intra-market price labels

Your current market label is open-to-close return and direction. That is useful but too weak for classifying market behavior.

Add per-market labels from raw futures trades:

```text
high_price
low_price
high_time
low_time
range_bps = (high - low) / open * 10000
close_location = (close - low) / (high - low)
max_up_bps_from_open
max_down_bps_from_open
realized_vol_5m
trade_vwap
vwap_deviation_bps = (close - vwap) / vwap * 10000
num_price_reversals
largest_1s_return_bps
largest_5s_return_bps
```

Then your market labels become richer:

```text
direction: up/down/flat
magnitude: tiny/small/medium/large/extreme
shape: trend/reversal/range/spike/fade
close_location: near_high/middle/near_low
volatility_regime: quiet/normal/volatile/shock
```

Example:

```text
open = 100000
high = 101000
low = 99900
close = 100050
return = +5 bps
range = 110 bps
```

Your current label says “slightly up.” A better label says “large upside spike that fully faded.” Those are totally different markets.

## 6. Cross-exchange BTC data

Yes, Binance is a good primary venue, but using only Binance means you cannot detect whether Binance is leading, lagging, or temporarily dislocated.

For a second venue, I would choose based on the question:

```text
OKX    = best second venue for BTC futures depth / derivatives comparison
Bybit  = very relevant for BTC spot and retail-perp flow
Coinbase = useful USD spot / U.S. venue signal
CME    = useful institutional futures context
```

CoinGlass’s Q1 2026 report shows Binance leading BTC futures depth, with OKX second and Bybit third for BTC futures depth; for BTC spot depth, Bybit was second and OKX third. The same report says OKX was the closest centralized challenger to Binance in derivatives volume, while Bybit was stronger in open-interest ranking and spot depth. ([coinglass][6])

You do not need to add ten exchanges immediately. Add one or two:

```text
binance_futures BTCUSDT perp
okx_futures BTC-USDT-SWAP
bybit_futures BTCUSDT perp
coinbase_spot BTC-USD
```

Then compute:

```text
cross_venue_mid_dispersion_bps
binance_mid_minus_okx_mid_bps
binance_mid_minus_bybit_mid_bps
coinbase_spot_minus_binance_spot_bps
venue_return_lead_lag_5s
venue_return_lead_lag_30s
venue_volume_share_5m
venue_spread_rank
venue_depth_rank
```

This is especially helpful for classifying:

```text
global move
Binance-local move
futures-led move
USD spot-led move
cross-exchange dislocation
```

## 7. Long/short ratios and trader positioning ratios

Binance exposes global long/short account ratio, top-trader long/short account ratio, and top-trader long/short position ratio. These are available at 5-minute periods, but the docs note the latest 30 days limitation for these endpoints. ([Binance Developers][7])

These are less “clean” than open interest because they are exchange-specific account aggregates, but they are useful as sentiment/positioning context.

Add:

```text
positioning_ratio_samples
- source
- symbol
- period
- timestamp
- global_long_short_ratio
- global_long_account
- global_short_account
- top_trader_position_ratio
- top_trader_long_position_pct
- top_trader_short_position_pct
- top_trader_account_ratio
```

Derived features:

```text
long_short_ratio_change_5m
top_trader_ratio_change_5m
crowding_score
retail_vs_top_trader_divergence
```

Useful market classes:

```text
crowded long market
crowded short market
top traders fading crowd
top traders aligned with crowd
positioning flip
```

## 8. Options and institutional derivatives context

For 5-minute Binance classification, options are not first priority. But for broader BTC regime classification, options help identify whether BTC is in a high-volatility, low-volatility, crash-risk, or call-chasing environment.

Useful fields:

```text
btc_options_iv_atm
btc_options_25d_skew
put_call_volume_ratio
put_call_oi_ratio
max_pain
dealer gamma proxy
large expiry dates
days_to_major_expiry
```

Deribit is usually the key venue for crypto options, while CME matters for regulated institutional futures/options. CME publishes Bitcoin futures volume and open-interest information and describes its Bitcoin futures/options suite as using the CME CF Bitcoin Reference Rate as the underlying reference. ([CME Group][8])

For your current system, this can be daily or hourly context rather than every 5 seconds.

## 9. Macro / traditional-market context

BTC often behaves differently depending on broader risk conditions. You do not need this for microstructure-only clustering, but it helps classify “market regimes.”

Add low-frequency context:

```text
nasdaq_return_5m / 1h / 1d
spx_return
dxy_return
gold_return
us_10y_yield_change
vix_change
fed_event_day
cpi_day
fomc_day
us_equity_session_flag
asia_session_flag
europe_session_flag
```

Useful classifications:

```text
crypto-native move
macro risk-on move
macro risk-off move
equity-hours move
weekend crypto-only move
event-driven volatility
```

Even simple time/session features are valuable:

```text
hour_utc
day_of_week
is_weekend
minutes_to_funding
minutes_after_funding
is_us_market_open
is_cme_open
```

## 10. Stablecoin and quote-asset context

Since your main symbol is `BTCUSDT`, you are partly measuring BTC and partly measuring the USDT-denominated crypto market.

Useful additions:

```text
BTCUSDC price
BTCUSD price from Coinbase/Kraken
USDT/USD price
USDC/USD price
USDT market cap / supply change
exchange stablecoin inflows/outflows if available
```

Derived features:

```text
usdt_depeg_bps
btcusdt_minus_btcusd_bps
btcusdt_minus_btcusdc_bps
stablecoin_basis_bps
```

This helps avoid misclassifying quote-asset stress as BTC-specific movement.

## 11. Data-quality and latency fields

This sounds boring, but it matters a lot for 1-second and 5-second buckets.

Add these to every sampled table where possible:

```text
scheduled_at
request_started_at
response_received_at
exchange_event_time
exchange_transaction_time
collector_lag_ms
request_latency_ms
schedule_delay_ms
source_server_time
raw_payload
```

Binance WebSocket payloads include event and/or transaction timestamps on streams such as aggregate trades and book-depth updates, so you should preserve those separately from your local collector receive time. ([Binance Developers][9])

This lets you distinguish:

```text
real market gap
collector delay
API latency spike
missed sample
exchange-side event burst
```

It also lets you later exclude bad windows rather than accidentally learning API artifacts.

# My recommended priority order

## Phase 1 — Add immediately

These give the biggest improvement with the least complexity:

```text
1. Binance futures mark/index price + premium
2. Binance futures funding rate
3. Binance futures open interest
4. Binance liquidation stream
5. Futures high/low/range/VWAP labels from agg_trades
6. Store raw book snapshot JSON or deeper depth snapshots
```

This turns your market classification from:

```text
price + flow + book
```

into:

```text
price + flow + book + leverage + forced selling/buying + perp premium
```

## Phase 2 — Add next

```text
1. Binance spot agg trades
2. Binance spot book samples
3. Binance spot market_features
4. Futures-vs-spot premium and flow divergence features
```

This lets you identify:

```text
spot-led
futures-led
squeeze
organic trend
dislocation
```

## Phase 3 — Add one more venue

Start with:

```text
OKX futures
```

Then add either:

```text
Bybit futures/spot
```

or:

```text
Coinbase BTC-USD spot
```

OKX is the best second venue if your main focus is futures market structure. Coinbase is more useful if you want USD spot and U.S.-session/institutional behavior. Bybit is useful if you want another major crypto-native retail/perp venue.

# Suggested new market classes

Once you add the missing fields, classify each 5-minute market into something like this:

```text
quiet_range
normal_trend_up
normal_trend_down
spot_led_up
spot_led_down
futures_led_up
futures_led_down
long_build
short_build
short_squeeze
long_squeeze
liquidation_cascade
absorption_buy_pressure
absorption_sell_pressure
liquidity_vacuum
cross_exchange_dislocation
funding_window_distortion
macro_session_move
```

A practical classification rule example:

```text
short_squeeze =
  return_pct > threshold
  and open_interest_change < 0
  and taker_buy_quote is high
  and short_liquidation_quote is high
  and close_location near high
```

Another:

```text
absorption_sell_pressure =
  taker_sell_quote is high
  and price_return is flat/up
  and bid_depth remains high
  and book_imbalance improves
```

Another:

```text
futures_led_up =
  futures_return > spot_return by X bps
  and premium_bps rises
  and futures_taker_imbalance > spot_taker_imbalance
```

# The most important missing fields, condensed

If you only add ten fields, add these:

```text
mark_price
index_price
premium_bps
funding_rate
open_interest_quote
open_interest_change_quote
liquidation_quote_buy_side
liquidation_quote_sell_side
spot_taker_imbalance
cross_exchange_mid_dispersion_bps
```

Those ten will probably improve your ability to classify BTC 5-minute markets more than simply increasing your price sampling frequency.

[1]: https://www.coingecko.com/research/publications/centralized-crypto-exchanges-market-share "Market Share of Centralized Crypto Exchanges, by Trading Volume | CoinGecko"
[2]: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Mark-Price "Mark Price | Binance Open Platform"
[3]: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Open-Interest-Statistics "Open Interest Statistics | Binance Open Platform"
[4]: https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Liquidation-Order-Streams?utm_source=chatgpt.com "Liquidation Order Streams | Binance Open Platform"
[5]: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Order-Book?utm_source=chatgpt.com "Order Book | Binance Open Platform"
[6]: https://www.coinglass.com/learn/2026-q1-mktshare-report-en "2026 Q1 Cryptocurrency Market Share Research Report | CoinGlass"
[7]: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Top-Trader-Long-Short-Ratio "Top Trader Long Short Position Ratio | Binance Open Platform"
[8]: https://www.cmegroup.com/markets/cryptocurrencies/bitcoin/bitcoin.volume.html?utm_source=chatgpt.com "Bitcoin Futures Volume & Open Interest"
[9]: https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Aggregate-Trade-Streams?utm_source=chatgpt.com "Aggregate Trade Streams | Binance Open Platform"
