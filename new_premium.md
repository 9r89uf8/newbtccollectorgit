Yes — **for the panel/feature you want to call `premium` or `basis`, use Binance’s basis feed instead of your local mark/index interpretation.**

Your current metric is not bad, but it should be renamed because it is really:

```text
mark_index_basis_bps = (markPrice - indexPrice) / indexPrice * 10000
```

That comes from `/fapi/v1/premiumIndex`, which Binance describes as the **Mark Price and Funding Rate** endpoint and which returns `markPrice`, `indexPrice`, `lastFundingRate`, `interestRate`, and `nextFundingTime`. ([Binance Developer Center][1]) Your own collector docs also say the current positioning samples store mark/index/funding/OI and derive `premium_bps` from those samples.

For **Binance-style basis**, add this endpoint:

```text
GET /futures/data/basis
```

with:

```text
pair=BTCUSDT
contractType=PERPETUAL
period=5m
```

Binance’s basis endpoint returns `indexPrice`, `futuresPrice`, `basisRate`, `basis`, `pair`, `contractType`, and `timestamp`, which is much closer to what the UI should call basis/premium. ([Binance Developer Center][2])

Recommended schema change:

```text
basis = Binance /futures/data/basis basis
basis_rate = Binance /futures/data/basis basisRate
basis_bps = basisRate * 10000

mark_index_basis_bps = ((markPrice - indexPrice) / indexPrice) * 10000
```

So I would change the panel like this:

```text
Display:
  basis_bps

Keep as secondary/debug:
  mark_index_basis_bps
```

And avoid calling the current field simply `premium_bps`. Better rename it to:

```text
mark_index_basis_bps
```

or:

```text
mark_premium_bps
```

One caveat: Binance basis supports periods like `5m`, `15m`, `30m`, etc., and only returns recent historical basis data; it is not a 5-second live sample feed. ([Binance Developer Center][2]) So for your 5-minute markets, Binance basis works well as a **market-level feature**, but not as a replacement for every 5-second derivative sample.

My recommendation:

```text
Use Binance basis for:
  premium/basis panel
  market-level basis_bps_start/end/change if available
  model features labeled as basis or premium

Keep /fapi/v1/premiumIndex for:
  mark_price
  index_price
  funding_rate
  minutes_to_funding
  mark_index_basis_bps as a separate internal feature
```

So, yes: **use Binance-style basis as the canonical premium/basis signal, and demote the current calculation to a separate mark-vs-index feature.**

[1]: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Mark-Price "Mark Price | Binance Open Platform"
[2]: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Basis "Basis | Binance Open Platform"
