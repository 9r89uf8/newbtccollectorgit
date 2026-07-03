For **1–2 minute BTC moves**, the thing I wish more people asked is:

**“Who is being forced to trade right now, and is there enough liquidity to absorb them?”**

At that horizon, candles and RSI matter less than **order-book imbalance, taker flow, perp premium, open interest, liquidation pressure, and liquidity gaps**. None of these are guarantees, but the best short-term signals usually happen when several of them point the same way.

## 1. The strongest simple pattern: thin book + aggressive taker flow

For an upside move, the setup is usually:

**Asks are thin near price + market buys are hitting + price is not rejected = short-term up pressure.**

A useful way to watch it:

```text
near-book imbalance = bid size within 0.05% / (bid size + ask size within 0.05%)

taker buy share = taker buy volume / total volume
```

A rough bullish micro-setup:

```text
bid-side imbalance > 60%
taker buy share > 60%
asks keep disappearing
spread stays controlled
price holds above the prior 30–60 second high
```

Mirror it for downside:

```text
ask-side imbalance > 60%
taker sell share > 60%
bids keep disappearing
spread stays controlled
price holds below the prior 30–60 second low
```

The key is not just “more bids than asks.” The key is **whether aggressive market orders are consuming the weak side of the book**. Research on crypto microstructure has found order-book imbalance useful for short-horizon directional prediction, and public exchange feeds give real-time orders/trades data that can be used to reconstruct this type of signal. ([arXiv][1])

## 2. The reversal pattern people miss: aggressive buying that stops moving price

This is one of the most underrated 1-minute BTC tells.

**If market buys are huge but price stops going up, that is not bullish. That is absorption.**

Example:

```text
BTC pushes into a local high.
Taker buy volume spikes.
CVD rises.
But price only moves a tiny amount or stalls.
Ask liquidity keeps refilling.
```

That often means a larger seller is absorbing buyers. Once the taker buying slows, price can drop fast because the buyers who just chased are now trapped.

Reverse version:

```text
Huge taker selling.
Price stops falling.
Bids keep refilling.
CVD drops but price refuses to make a new low.
```

That can mark short-term seller exhaustion.

My simple phrase for this:

**If aggressive buying cannot lift price, buyers are becoming exit liquidity.
If aggressive selling cannot push price lower, sellers are becoming exit liquidity.**

## 3. Perp-only moves are suspicious until spot confirms

For BTC, many very short moves start in perpetual futures. That does not make them fake, but it changes the risk.

A bullish move is healthier when:

```text
spot BTC rises
perps follow
OI is not exploding too fast
perp premium is not stretched
```

A weaker, more fragile move is:

```text
perps pump first
spot lags
open interest rises fast
perp trades rich to spot
funding/premium heats up
```

That can still squeeze upward for 1–2 minutes, but it becomes vulnerable to a snapback once the aggressive perp buying stops.

Perpetual funding exists to keep perp prices aligned with spot prices; when the perp trades above spot, longs typically pay shorts, and when it trades below spot, shorts typically pay longs. So for ultra-short moves, I would not treat the 8-hour funding print itself as the signal. I would watch the **live perp premium/discount versus spot**. ([Coin Metrics Docs][2])

## 4. Open interest tells you whether the move is new positioning or forced exit

For 1–2 minute BTC moves, I like these four combinations:

| Price | Open Interest | What it often means                                                      |
| ----- | ------------: | ------------------------------------------------------------------------ |
| Up    |            Up | New leverage entering; can continue, but can become crowded              |
| Up    |          Down | Shorts closing/liquidating; squeeze may be burning fuel                  |
| Down  |            Up | New shorts or trapped longs adding; can continue if spot confirms        |
| Down  |          Down | Longs closing/liquidating; often violent, but can reverse after the puke |

The most explosive setup is often:

```text
price flat for a while
OI rises
range tightens
depth gets thin
then price breaks the range
```

That means leverage built up inside a compressed range. When the break happens, one side is suddenly wrong. Binance exposes present open interest and historical open-interest endpoints, and its kline data includes taker-buy volume fields, which are useful for building this kind of dashboard. ([Binance Developer Center][3])

## 5. Liquidation moves depend on mark price, not just the candle wick

A lot of traders stare at the last traded price and miss this.

On Binance Futures, liquidation is tied to **mark price**, not just last price. Binance says mark price is calculated using funding data and a basket of spot-exchange prices, and liquidation occurs when mark price hits a position’s liquidation price. ([Binance][4])

So the pattern is:

```text
last price wicks up/down
mark price does not follow
spot/index does not follow
```

That wick is less likely to create a real liquidation cascade.

But if this happens:

```text
last price moves
mark price follows
spot/index follows
liquidations print
OI drops
```

Then the move is more real because forced exits are actually being triggered.

That is why a “fakeout wick” and a “liquidation cascade” can look similar on a 1-minute candle but behave completely differently.

## 6. Liquidity gaps matter more than people think

Sometimes BTC does not move because “bullish news” happened. It moves because there is simply **nothing in the book**.

A pattern I would watch:

```text
market depth within 0.05%–0.10% drops
spread widens
volume is mediocre
price suddenly jumps
```

That is a liquidity vacuum. The same market buy that normally moves BTC $20 might move it $100 when the book is thin.

Crypto liquidity is fragmented across venues, and Kaiko has noted that liquidity shortages spread across many exchanges/pairs can worsen volatility and disrupt price discovery. ([Kaiko][5])

## 7. “Wall appears” is less important than “wall disappears”

A big visible bid wall is not automatically bullish. It can be spoofed, pulled, or used as bait.

The better signal is:

```text
large ask wall sits above price
market buys hit it
wall gets eaten instead of pulled
price holds above the wall after breaking
```

That is more bullish than simply seeing a big bid.

Bearish mirror:

```text
large bid wall sits below price
market sells hit it
wall gets eaten
price accepts below that level
```

That usually means the support was not real support; it was just liquidity.

## 8. BTCUSDT can lie when the stablecoin leg moves

This is subtle.

If you are watching **BTCUSDT**, a move can partly come from USDT moving, not BTC itself. If USDT trades slightly below $1, BTCUSDT can look higher than BTCUSD. If USDT strengthens, BTCUSDT can look weaker.

So in fast moves, compare:

```text
BTCUSDT
BTCUSD
BTCUSDC
perp index price
Coinbase BTC-USD
```

Stablecoins can and have depegged or traded at small premiums/discounts, and Kaiko has tracked USDT and other stablecoin depeg behavior. ([Kaiko][6])

## 9. Venue leadership rotates

People often say “Binance leads” or “Coinbase leads,” but for 1–2 minute moves the leader can change.

Sometimes the driver is:

```text
Coinbase spot bid → perps follow
```

That is usually cleaner upside.

Sometimes it is:

```text
Binance/Bybit perp impulse → spot follows late
```

That can be a squeeze, but it is more fragile.

Sometimes during U.S. market hours:

```text
CME futures move → crypto venues reprice
```

A 2025 high-frequency study of Bitcoin spot and futures markets found CME Bitcoin futures played a leading role in price formation, with transaction size affecting market leadership. ([IDEAS/RePEc][7])

So I would not ask, “Which exchange always leads?” I would ask:

**“Which venue is leading right now, and is the other venue confirming within seconds?”**

## A practical 1–2 minute checklist

For a possible **up move**, I would want at least 4 of these 6:

```text
1. Ask depth within 0.05% is thin or being pulled.
2. Taker buy share is above 60%.
3. Price accepts above the last 30–60 second high.
4. Spot confirms; not only perps.
5. OI is rising moderately or shorts are being squeezed.
6. Spread does not blow out against the move.
```

For a possible **down move**, mirror it:

```text
1. Bid depth within 0.05% is thin or being pulled.
2. Taker sell share is above 60%.
3. Price accepts below the last 30–60 second low.
4. Spot confirms; not only perps.
5. OI suggests longs are trapped or liquidating.
6. Spread does not blow out against the move.
```

The trap condition:

```text
price makes new high
taker buys are aggressive
perp premium rises
OI rises
but spot does not confirm
and price stalls
```

That is often a short-term reversal/snapback setup.

The cleaner continuation condition:

```text
price breaks level
taker flow confirms
spot and perps move together
book refills behind price
mark/index follows
OI/liquidations support the move
```

That is the type of move more likely to continue for another 1–2 minutes.

## The big idea

For ultra-short BTC moves, I would stop asking:

**“Is BTC bullish or bearish?”**

And start asking:

**“Where is liquidity thin, who is trapped, and who has to market-buy or market-sell next?”**

That is the core of almost every fast BTC move.

[1]: https://arxiv.org/html/2602.00776v1 "Explainable Patterns in Cryptocurrency Microstructure"
[2]: https://gitbook-docs.coinmetrics.io/market-data/market-data-overview/funding-rates/funding-rates "Funding Rates | Product Docs"
[3]: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Open-Interest "Open Interest | Binance Open Platform"
[4]: https://www.binance.com/en/support/faq/detail/360033525271 "Binance Futures Liquidation Protocols | Futures last price,Futures mark price,Binance futures liquidation,Mark price vs last price"
[5]: https://www.kaiko.com/resources/the-crypto-liquidity-concentration-report "The Crypto Liquidity Concentration Report - Kaiko"
[6]: https://www.kaiko.com/resources/defining-depegs-a-new-metric-for-stablecoin-stability?utm_source=chatgpt.com "Defining Depegs: A New Metric for Stablecoin Stability - Kaiko"
[7]: https://ideas.repec.org/a/eee/jimfin/v159y2025ics0261560625001500.html "Price discovery in bitcoin spot and futures markets"


###### the suggested plan on how to do it
Yes — **you collect most of the necessary data for #1, #2, and #4**, especially for **post-hoc analysis**. The biggest caveat is that your data is strongest for **Binance Futures microstructure**, not full cross-venue BTC market structure.

My read:

| Pattern                                                          |                                Do you collect enough? | Confidence |
| ---------------------------------------------------------------- | ----------------------------------------------------: | ---------- |
| **1. Thin book + aggressive taker flow**                         |                                       **Yes, mostly** | High       |
| **2. Absorption: aggressive buying/selling fails to move price** |                                       **Yes, mostly** | High       |
| **4. Price + open interest interpretation**                      |                                               **Yes** | High       |
| **True 1–2 minute labels**                                       | **1 minute yes, 2 minutes not yet as a stored label** | Medium     |

## 1. Thin book + aggressive taker flow

You collect the core ingredients.

For **aggressive taker flow**, you store Binance Futures aggregate trades in `agg_trades`, including:

```text
trade_time
price
quantity
quote_notional
buyer_is_maker
taker_side
```

Your document explicitly maps:

```text
buyer_is_maker = false -> taker_side = buy
buyer_is_maker = true  -> taker_side = sell
```

So you can calculate things like:

```text
taker_buy_quote
taker_sell_quote
net_taker_quote
taker_buy_share
taker_imbalance
large_aggressive_trade_count
```

That is exactly what you need for the “market buys are hitting” or “market sells are hitting” part.

For **thin book / liquidity imbalance**, you store Binance Futures top-100 depth metrics in `book_samples`, including:

```text
bid_depth_5bps
ask_depth_5bps
book_imbalance_5bps
bid_depth_10bps
ask_depth_10bps
book_imbalance_10bps
bid_depth_25bps
ask_depth_25bps
book_imbalance_25bps
spread_bps
best_bid_price
best_ask_price
```

That is enough to test a rule like:

```text
ask_depth_5bps is low
+
taker_buy_quote is high
+
price moves up over next 5s/10s/30s/60s
```

or the bearish version:

```text
bid_depth_5bps is low
+
taker_sell_quote is high
+
price moves down over next 5s/10s/30s/60s
```

Your `book_imbalance_5bps` is especially useful because 5 bps equals **0.05%**, which matches the near-book range I mentioned earlier. The formula you use is:

```text
(bid_depth - ask_depth) / (bid_depth + ask_depth)
```

So one important conversion:

```text
bid share = (book_imbalance + 1) / 2
```

That means:

```text
60% bid-side share = book_imbalance around +0.20
60% ask-side share = book_imbalance around -0.20
```

So do **not** use `book_imbalance_5bps > 0.60` as “60% bid side.” That would actually mean the bid side is about 80% of near-book liquidity.

The limitation: your REST depth samples are on the scheduled market cadence: every 5 seconds normally, then every 1 second only in the final 20 seconds of the 5-minute market. You also have WebSocket `@bookTicker` summaries at 1-second resolution, but those capture top-of-book movement, not the full 5/10/25 bps depth ladder.

So for #1:

```text
Can analyze 5s/10s/30s/60s patterns? Yes.
Can analyze 1–2 minute patterns? Yes.
Can analyze sub-second liquidity pulling/refilling? Not really.
Can analyze full depth wall behavior at exact price levels? Not fully, because raw depth updates are not stored.
```

## 2. Absorption: aggressive flow but price stalls

You also collect enough for this.

Absorption needs three things:

```text
1. Aggressive buy/sell pressure
2. Price response
3. Evidence that pressure failed to move price
```

You have aggressive pressure from `agg_trades`, `market_feature_buckets`, and `market_cvd_buckets`.

Your per-bucket features include:

```text
net_taker_quote
taker_imbalance
agg_trade_count
open_price
close_price
return_pct
spread_bps
book_imbalance_5bps
bid_depth_5bps
ask_depth_5bps
```

That lets you test cases like:

```text
net_taker_quote strongly positive
but close_price barely changes
and ask_depth_5bps does not disappear
```

That would be possible **buy absorption**.

The reverse:

```text
net_taker_quote strongly negative
but close_price barely changes
and bid_depth_5bps does not disappear
```

That would be possible **sell absorption**.

You also already derive CVD-style fields in `market_cvd_buckets`:

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

That is directly useful for detecting:

```text
CVD up + price flat/down = possible buy absorption
CVD down + price flat/up = possible sell absorption
```

Your document even notes that this CVD is post-market derived from the existing bucket trade-flow delta, which is fine because you said this is for later analysis, not live trading.

You also already have behavior classifications that include:

```text
buy_pressure_absorbed
sell_pressure_absorbed
```

That means your system is already conceptually prepared for this pattern.

The extra good part: your `market_microprice_buckets` include fields like:

```text
price_stalled_10s / 30s
microprice_lean
avg_lean_10s / 30s
up_lean_share_10s / 30s
down_lean_share_10s / 30s
spread_stable_10s / 30s
```

That can help detect “pressure is leaning one way, but price is not following.”

The limitation: you do **not** store raw WebSocket book messages or raw liquidation events. The WebSocket data is summarized into 1-second rows. That is enough for 1–2 minute research, but it will miss some fine-grained absorption behavior like:

```text
same ask wall refilled 40 times inside 3 seconds
large passive seller keeps refreshing exactly at 106,250
iceberg-like behavior at one exact level
```

Your data can identify the **effect** of absorption. It cannot perfectly reconstruct every passive order-book action that caused it.

## 4. Price + open interest interpretation

Yes, you collect the necessary data here.

You store Binance Futures positioning samples in `derivative_position_samples`, including:

```text
mark_price
index_price
premium_bps
funding_rate
next_funding_time
open_interest_base
open_interest_quote
```

And your market-level positioning features include:

```text
open_interest_quote_start
open_interest_quote_end
open_interest_change_quote
open_interest_change_pct
premium_bps_start
premium_bps_end
premium_bps_change
mark_price_start
mark_price_end
```

That is enough to test the basic OI combinations:

```text
price up + OI up    = new leverage entering
price up + OI down  = shorts closing / squeeze / deleveraging
price down + OI up  = new shorts or trapped longs adding
price down + OI down = longs closing / liquidation / deleveraging
```

Your positioning calls run on a **5-second cadence**, which is good enough for 1–2 minute analysis. It would not be ideal for sub-second liquidation cascade analysis, but that is not what you are doing.

You also collect 1-second liquidation summaries from the Binance Futures `@forceOrder` stream:

```text
liquidation_count
liquidation_buy_quote
liquidation_sell_quote
liquidation_net_quote
liquidation_max_quote
```

That is very useful because it lets you distinguish:

```text
price up + OI down + liquidation_buy_quote high
```

from:

```text
price up + OI down but no meaningful liquidation
```

The first looks more like forced short exits. The second may be voluntary closing or normal position reduction.

The main limitation with OI is interpretive, not data availability. Open interest tells you **position count/value changed**, but it does not directly tell you whether the new positions were opened by confident longs, aggressive shorts, hedgers, market makers, or trapped traders. You infer that by combining:

```text
price change
taker flow
premium_bps
mark/index movement
liquidations
open_interest_change
```

Your dataset has those ingredients.

## The biggest gap for your exact “1 to 2 minute moves” goal

You already store forward labels for:

```text
1s, 5s, 10s, 15s, 30s, 60s
```

So you are covered for **up to 1 minute** as a stored label. But you do **not** currently list a `120s` forward label.

For your stated goal, I would add:

```text
120s
```

Maybe also:

```text
90s
120s
```

So the horizon set becomes:

```text
1s, 5s, 10s, 15s, 30s, 60s, 90s, 120s
```

You probably do **not** need a new feed for that. Since forward labels are derived from `futures_ws_1s_summaries`, you should be able to derive 90s/120s labels from the same 1-second summary data, as long as you handle crossing 5-minute market boundaries correctly.

## What I would analyze first with your current data

I would start with three research tables/views.

### A. Thin book + taker flow continuation

Use:

```text
market_feature_buckets
market_forward_labels
market_microprice_buckets
```

Test:

```text
book_imbalance_5bps > +0.20
taker_imbalance > +0.20
ask_depth_5bps below rolling percentile
spread_bps stable
```

Then check:

```text
forward_return_bps over 5s / 10s / 30s / 60s
hit_up_before_down
direction_label
```

Bearish version:

```text
book_imbalance_5bps < -0.20
taker_imbalance < -0.20
bid_depth_5bps below rolling percentile
spread_bps stable
```

### B. Absorption / failed pressure

Bullish-pressure absorption:

```text
taker_imbalance strongly positive
cvd_change_5b positive
price_change_5b_bps flat or negative
price_stalled_10s = true
ask depth does not collapse
```

Bearish-pressure absorption:

```text
taker_imbalance strongly negative
cvd_change_5b negative
price_change_5b_bps flat or positive
price_stalled_10s = true
bid depth does not collapse
```

Then check whether the next 30s/60s move reverses.

### C. OI regime filter

Use:

```text
market_position_features
market_feature_buckets
market_forward_labels
futures_ws_1s_summaries
```

Classify each window as:

```text
price_up_oi_up
price_up_oi_down
price_down_oi_up
price_down_oi_down
```

Then split by:

```text
premium_bps_change
liquidation_net_quote
taker_imbalance
spread_bps
```

This should tell you whether OI adds predictive value by itself, or only when combined with taker flow and liquidations.

## My final answer

**Yes, you collect the necessary data for #1, #2, and #4 for later analysis.**

The data is especially good for:

```text
Binance Futures taker flow
near-book liquidity imbalance
CVD divergence
microprice pressure
price stalling
open interest changes
premium/mark/index context
liquidation pressure
1s to 60s forward outcomes
```

The main things I would add or improve are:

```text
1. Add 90s and 120s forward labels.
2. Store deeper/raw order-book updates only if you want exact wall/refill behavior.
3. Add spot trades/order book only if you want true spot-vs-perp flow confirmation.
4. Keep raw agg_trades, because they let you recompute better buckets later.
```

For your current purpose — **studying 1–2 minute BTC moves after the fact** — your collector is already in pretty good shape.
