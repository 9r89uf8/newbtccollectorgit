# Live Latest-Market Dashboard Plan

This project needs two separate dashboard surfaces:

```text
Historical market dashboard
  /markets
  /markets/[marketId]
  /markets/[marketId]/transition
  Reads PostgreSQL rows for a chosen market.
  Answers: how did this specific 5 minute market play out?

Live latest-market dashboard
  /live
  Follows the current BTC 5 minute market automatically.
  Reads the collector's current in-memory snapshot plus compact recent rows.
  Answers: what is happening right now in the latest market?
```

Do not merge the live view into `app/markets/[marketId]/page.js`. That page is a replay/detail view with complete or nearly complete market rows. The live view should have its own route, data contract, stale-state handling, and chart assumptions.

## Correctness Check

The high-level recommendation is right: keep one JavaScript collector process, add WebSocket-fed in-memory state, and avoid storing raw firehose messages. The plan needs these local corrections:

- The existing app already has the historical dashboard in `app/markets/[marketId]/page.js` and `lib/marketDetailData.js`. Treat it as post-market/replay code.
- The current collector already has Binance Futures `bookTicker` and `forceOrder` WebSocket summaries in `collector/futuresWebSocketSummaries.mjs`.
- The current collector already has Polymarket RTDS Chainlink BTC ticks in `collector/chainlinkBtcSamples.mjs`.
- The current Polymarket probability path is still REST-based CLOB `/midpoints`; live probabilities need a new Polymarket CLOB market WebSocket adapter.
- Live CVD needs Binance Futures `aggTrade` WebSocket input. The current CVD path is derived after close from REST `agg_trades`.
- If we expose `/events` from the collector, use Node's built-in `node:http` server or add an explicit dependency. The current repo does not use Express.
- Keep the live API bound to `127.0.0.1`; proxy it through Next.js or an SSH tunnel. Do not expose the collector API publicly.

The external endpoint choices also check out against current primary docs:

- Polymarket CLOB market WebSocket: `wss://ws-subscriptions-clob.polymarket.com/ws/market`, subscribe with `assets_ids`, `type: "market"`, and `custom_feature_enabled: true` for `best_bid_ask`.
- Polymarket RTDS: `wss://ws-live-data.polymarket.com`, subscribe to `crypto_prices_chainlink` with `{"symbol":"btc/usd"}`, and send `PING` every 5 seconds.
- Binance Futures now splits WebSocket traffic by route. Use `/public` for high-frequency public data and `/market` for regular market data.
- For this repo, prefer Binance combined stream query mode because `collector/config.mjs` already uses it:

```text
wss://fstream.binance.com/public/stream?streams=btcusdt@bookTicker
wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade/btcusdt@forceOrder/btcusdt@markPrice@1s
```

## Target Architecture

Keep this as one collector process under systemd:

```text
collector
  polymarket-discovery        Gamma REST, current and next market metadata
  polymarket-clob-ws          live Up/Down orderbook and probability
  polymarket-rtds-ws          live Polymarket Chainlink BTC reference price
  binance-futures-public-ws   live bookTicker, optional depth
  binance-futures-market-ws   live aggTrade, forceOrder, markPrice@1s
  live reducer                current state, current 1s bucket, current market totals
  postgres writer            compact history and reload recovery
  localhost live API          snapshot JSON plus SSE
```

Node is fine here. The latency gains come from WebSockets, batching, and keeping dashboard reads off the ingestion path. Do not rewrite to Go unless measured event-loop lag becomes the actual bottleneck.

## Route Separation

Use these boundaries:

| Surface | Route | Data source | Refresh model | Purpose |
| --- | --- | --- | --- | --- |
| Collection console | `/` | PostgreSQL dashboard queries | Page refresh | Collector health and recent market list. |
| Market list | `/markets` | PostgreSQL | Page refresh | Browse UTC-day markets. |
| Market detail | `/markets/[marketId]` | PostgreSQL | Page refresh | Explain one market after or near close. |
| Live latest | `/live` | Collector live API plus compact recent rows | SSE | Watch the current market in real time. |

Rules:

- `/live` automatically follows the current market window from `getMarketWindow()` logic. It should not require a market id.
- `/live` can link to `/markets/[marketId]`, but it should not reuse the historical page's server query path.
- Historical detail pages should not subscribe to live feeds. They should keep reading persisted rows.
- Share formatting helpers if useful, but do not force the same chart data shape. Historical charts expect completed arrays; live charts need append/update semantics and stale markers.

## Live State Contract

The live API should return one coalesced snapshot. Keep it explicit and small:

```js
{
  market: {
    id,
    symbol,
    slug,
    startTime,
    endTime,
    secondsElapsed,
    secondsRemaining,
    status
  },
  polymarket: {
    upTokenId,
    downTokenId,
    up: { bid, ask, mid, lastTradePrice, ts, ageMs },
    down: { bid, ask, mid, lastTradePrice, ts, ageMs },
    normalizedUp,
    normalizedDown,
    probabilitySum,
    quality
  },
  chainlink: {
    price,
    exchangeTs,
    receivedTs,
    ageMs,
    quality
  },
  binance: {
    bestBid,
    bestAsk,
    mid,
    spreadBps,
    microprice,
    markPrice,
    indexPrice,
    fundingRate,
    eventLagMs,
    quality
  },
  flow: {
    takerBuyQuote1s,
    takerSellQuote1s,
    netTakerQuote1s,
    grossTakerQuote1s,
    cvdMarketQuote,
    cvdContinuousQuote,
    rollingNet30s,
    rollingGross30s,
    rollingImbalance30s,
    tradeCount1s
  },
  liquidations: {
    buyQuote1s,
    sellQuote1s,
    netQuote1s,
    count1s
  },
  collector: {
    snapshotTs,
    eventLoopLagMs,
    reconnectCount,
    staleSources
  }
}
```

All displayed fields should carry either source timestamps or age/quality fields. The live page should show stale states clearly instead of silently carrying old values.

## Storage

Use three layers:

```text
1. In memory
   Latest snapshot.
   Current 1-second bucket accumulator.
   Current 5-minute market accumulators.

2. live_state
   One small reload-recovery row per key, overwritten frequently.

3. Compact history
   Existing summary tables where possible.
   New compact 1-second live rows only for data that does not fit existing tables.
```

Add a minimal reload-recovery table:

```sql
create table if not exists live_state (
  key text primary key,
  updated_at timestamptz not null default now(),
  market_id text,
  payload jsonb not null
);
```

Use keys like:

```text
latest
market:<market_id>
source:binance_futures_ws
source:polymarket_clob_ws
source:polymarket_rtds_chainlink
```

Do not create a second copy of existing historical tables just for the dashboard. The live reducer can keep in-memory series for the active chart, while Postgres keeps compact rows for reload and later analysis.

For compact history:

- Keep using `futures_ws_1s_summaries` for Binance top-of-book and liquidations.
- Add `aggTrade` fields to a compact 1-second flow table or write near-real-time rows compatible with `market_trade_flow_1s`.
- Add a compact Polymarket CLOB 1-second table only if the live probability history needs to survive collector restarts. Otherwise keep the latest snapshot and continue scheduled `polymarket_probability_samples` until the WebSocket path replaces it.
- Do not store raw WebSocket messages, raw orderbook deltas, or raw liquidation events.

Retention can stay simple:

```sql
delete from live_state
where updated_at < now() - interval '2 hours'
  and key <> 'latest';

delete from collection_errors
where time < now() - interval '7 days';
```

## Feed Details

### Polymarket Discovery

Keep the deterministic slug:

```js
function currentMarketStartEpochSec(nowMs = Date.now()) {
  return Math.floor(nowMs / 300_000) * 300;
}

function marketSlug(epochSec) {
  return `btc-updown-5m-${epochSec}`;
}
```

The repo already has equivalent market-window logic in `collector/time.mjs` and slug logic in `collector/polymarketSamples.mjs`; reuse those rather than duplicating new time math.

Prefetch current and next Polymarket metadata. Subscribe to next-market CLOB token ids before the boundary when available. At the boundary, switch the live snapshot to the new market and unsubscribe old tokens after a short grace period.

### Polymarket CLOB WebSocket

Use the CLOB market WebSocket for live Up/Down state:

```text
wss://ws-subscriptions-clob.polymarket.com/ws/market
```

Subscribe with the exact field name from the docs:

```json
{
  "assets_ids": ["<up_token_id>", "<down_token_id>"],
  "type": "market",
  "custom_feature_enabled": true
}
```

Maintain Up and Down independently. Do not infer Down as `1 - Up`.

Display probability should usually be:

```text
up_mid = (up_best_bid + up_best_ask) / 2
down_mid = (down_best_bid + down_best_ask) / 2

normalized_up = up_mid / (up_mid + down_mid)
normalized_down = down_mid / (up_mid + down_mid)
```

Only normalize when both sides have usable midpoints and the sum is positive. Also expose the raw Up midpoint, raw Down midpoint, and raw sum because spread, missing sides, and partial books matter.

### Polymarket RTDS Chainlink

Keep the existing RTDS path for the Polymarket BTC reference:

```text
wss://ws-live-data.polymarket.com
topic: crypto_prices_chainlink
symbol: btc/usd
```

This is the right live reference for Polymarket's BTC price path. Keep it separate from Gamma settlement fields `price_to_beat` and `end_price`, because live observed ticks and later official settlement metadata can differ.

### Binance Futures

Use two WebSocket connections:

```text
public: bookTicker, optional depth
market: aggTrade, forceOrder, markPrice@1s
```

Current repo state:

```text
implemented: bookTicker
implemented: forceOrder
missing:     aggTrade
missing:     markPrice@1s
```

`aggTrade` is the missing piece for live CVD. Use Binance `m` the same way the existing REST aggregate-trade code does:

```text
m = false -> buyer was taker -> taker buy quote
m = true  -> seller was taker -> taker sell quote
quote = price * quantity
```

Build per-second flow and rolling windows from the live stream, then persist compact rows.

## Collector API

Keep the collector API private and local:

```text
collector listens on 127.0.0.1:8787
Next.js route handler proxies /api/live/events to the collector
browser uses EventSource("/api/live/events")
```

For local access to a droplet collector:

```bash
ssh -N -L 8787:127.0.0.1:8787 root@DROPLET_PUBLIC_IPV4
```

The collector can use Node's built-in HTTP server:

```js
import http from "node:http";

const clients = new Set();

const server = http.createServer((req, res) => {
  if (req.url === "/snapshot") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(getPublicLiveSnapshot()));
    return;
  }

  if (req.url === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive"
    });
    clients.add(res);
    res.write(`data: ${JSON.stringify(getPublicLiveSnapshot())}\n\n`);
    req.on("close", () => clients.delete(res));
    return;
  }

  res.writeHead(404);
  res.end();
});

function broadcastLiveSnapshot() {
  const message = `data: ${JSON.stringify(getPublicLiveSnapshot())}\n\n`;
  for (const client of clients) client.write(message);
}

server.listen(8787, "127.0.0.1");
```

Broadcast at 250 ms to 1000 ms. Do not send every raw feed message to the browser.

## Live Page

The first version of `/live` should include:

- Market clock: current UTC window, seconds elapsed, seconds remaining.
- Polymarket card: raw Up/Down bid/ask/mid, normalized Up/Down, data age.
- Chainlink BTC card: latest RTDS BTC/USD price, age, quality.
- Binance card: futures mid, spread bps, microprice lean, mark/index basis if `markPrice@1s` is enabled.
- Flow card: 1s net taker, 30s rolling imbalance, market CVD.
- Liquidations card: 1s and market cumulative net liquidation quote.
- Live chart: BTC mid, Chainlink BTC, normalized Up probability, CVD, microprice lean/pressure.
- Stale-source strip: source age and reconnect counters.
- Link to the current market detail page.

For chart history, keep a browser-side ring buffer for the active market and seed it from compact recent rows on load. At a market boundary, archive the previous ring buffer in memory only if useful, then reset the `/live` chart to the new market.

## Implementation Order

1. Add `live_state` to `db/schema.sql`.
2. Add a small collector live-state module that owns the reducer and exposes `getPublicLiveSnapshot()`.
3. Wire existing Binance `bookTicker`, `forceOrder`, and RTDS Chainlink handlers into the live reducer.
4. Add Binance `aggTrade` and `markPrice@1s` streams to `FUTURES_WEBSOCKET_SOURCE.marketStreams()`.
5. Add live per-second flow aggregation for `aggTrade`.
6. Add Polymarket CLOB market WebSocket adapter using the current and next Up/Down token ids.
7. Add the collector localhost HTTP/SSE server, disabled by env if needed.
8. Add a Next route handler that proxies SSE from the collector.
9. Add `/live` and a client chart component.
10. Link `/live` from the collection console.
11. Verify locally with the collector and `npm run build`.

Because steps 1 through 7 affect the collector or its runtime dependencies, follow `deployment.md` for commit, push, droplet deploy, and verification. Do not run the droplet deploy script for docs-only changes.

## Latency And Reliability Checklist

Use this as the minimum bar:

- WebSockets for live values; REST only for discovery, fallback, and settlement.
- One long-lived connection per Binance traffic class.
- WebSocket handlers update memory immediately and do minimal synchronous work.
- Persist compact summaries once per second.
- Keep dashboard reads off the ingestion path.
- Track source event timestamp, collector receive timestamp, DB write timestamp, and SSE send timestamp.
- Track event-loop lag, reconnect count, stale source count, missed bucket count, and Postgres write latency.
- Planned reconnect/resubscribe for Binance before the 24-hour connection limit.
- `PING` every 10 seconds for Polymarket CLOB market/user channels.
- `PING` every 5 seconds for Polymarket RTDS.
- Chrony/NTP on the droplet.

## References

- [Polymarket CLOB market WebSocket](https://docs.polymarket.com/market-data/websocket/market-channel)
- [Polymarket RTDS](https://docs.polymarket.com/market-data/websocket/rtds)
- [Polymarket WebSocket overview](https://docs.polymarket.com/market-data/websocket/overview)
- [Binance Futures WebSocket routing change](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/Important-WebSocket-Change-Notice)
- [Binance Futures bookTicker stream](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Individual-Symbol-Book-Ticker-Streams)
- [Binance Futures aggTrade stream](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Aggregate-Trade-Streams)
- [Binance Futures forceOrder stream](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Liquidation-Order-Streams)
- [Binance Futures markPrice stream](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Mark-Price-Stream)
