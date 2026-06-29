# newbtccollector

Private BTCUSDT 5 minute market collector and dashboard.

This repo intentionally uses plain JavaScript. It does not use TypeScript, Docker, or scheduled backup jobs.

## What is included

- Next.js dashboard in `app/`
- Separate Node collector in `collector/`
- PostgreSQL schema in `db/schema.sql`
- Database setup script in `scripts/setupDb.mjs`
- systemd service templates in `ops/systemd/`

## Local setup

Install dependencies:

```bash
npm install
```

Create `.env` from `.env.example` and set `DATABASE_URL`:

```bash
cp .env.example .env
```

Set up the database tables:

```bash
npm run db:setup
```

Run the dashboard:

```bash
npm run dev
```

Run the collector in a separate terminal:

```bash
npm run collector
```

Open `http://localhost:3000`.

Click a market timestamp in the dashboard to open its dedicated detail page at:

```text
/markets/<market_id>
```

## Collector schedule

Each BTCUSDT market is a 5 minute UTC window.

- Every 5 seconds from 0s through 275s
- Every 1 second from 280s through 299s
- One close sample at exactly 300s

The close sample for one window is also the open sample for the next window when the collector is running continuously.

## Futures microstructure

The collector records the original spot/futures last-price samples and, by default, futures microstructure features:

- Binance Futures aggregate trades for taker buy/sell flow
- Binance Futures top-20 book depth for liquidity and imbalance
- Binance Futures mark/index/funding/open-interest positioning samples on a 5 second cadence
- Binance Futures WebSocket book-ticker and liquidation 1-second summaries
- One derived `market_features` row per closed market
- One derived `market_position_features` row per closed market
- One derived `market_behavior_labels` row per closed market
- One derived `market_classifications` row per closed market
- Per-timestamp `market_feature_buckets` rows inside each market
- Forward outcome labels for 1s, 5s, 10s, 15s, 30s, and 60s horizons
- Polymarket 5 minute BTC Up/Down market metadata and CLOB midpoint probabilities

Relevant env settings:

```bash
ENABLE_FUTURES_MICROSTRUCTURE=true
ENABLE_FUTURES_POSITIONING=true
ENABLE_FUTURES_WEBSOCKET_SUMMARIES=true
ENABLE_POLYMARKET_BTC_5M=true
POLYMARKET_TIMEOUT_MS=4000
POLYMARKET_METADATA_PREFETCH_LEAD_MS=60000
FORWARD_LABEL_MIN_THRESHOLD_BPS=1
LARGE_TRADE_QUOTE_THRESHOLD=1000000
MAX_AGG_TRADE_PAGES_PER_MARKET=30
```

Set `ENABLE_FUTURES_MICROSTRUCTURE=false` to run only the original price collector plus Polymarket, unless Polymarket is separately disabled. Set `ENABLE_FUTURES_POSITIONING=false` to keep futures trade/book collection but skip mark/index/funding/open-interest samples. Set `ENABLE_FUTURES_WEBSOCKET_SUMMARIES=false` to disable the Binance Futures WebSocket summary feed. Set `ENABLE_POLYMARKET_BTC_5M=false` to disable Polymarket probability collection.

The collector prefetches Polymarket market metadata before the next 5 minute window starts, then records the next market opening CLOB midpoint sample at the prior market close boundary. `POLYMARKET_METADATA_PREFETCH_LEAD_MS` controls how early that metadata lookup starts.

After the bucket schema exists, existing closed markets can be materialized with:

```bash
npm run features:backfill-buckets -- 288
```

## Data model

See `docs/data-model.md` for a detailed explanation of what the collector records and how 5 minute markets work.

## Database tables

- `markets`
- `price_samples`
- `agg_trades`
- `book_samples`
- `market_labels`
- `market_features`
- `derivative_position_samples`
- `futures_ws_1s_summaries`
- `market_position_features`
- `market_behavior_labels`
- `market_classifications`
- `market_feature_buckets`
- `market_forward_labels`
- `polymarket_5m_btc_markets`
- `polymarket_probability_samples`
- `collector_heartbeats`
- `collection_errors`

`npm run db:setup` creates the core PostgreSQL schema. If TimescaleDB is installed, it also attempts to convert `price_samples`, `book_samples`, `derivative_position_samples`, `polymarket_probability_samples`, `futures_ws_1s_summaries`, and `market_forward_labels` into hypertables.

## Health endpoint

```text
/api/health
```

Returns database configuration status, latest collector heartbeat, 24 hour market counts, and feature stats.

## Droplet operations

See `docs/deployment.md` for:

- setting up a brand new Droplet
- running the collector with systemd
- pulling code changes and restarting the collector with one-command SSH deploy
- reading the Droplet database from localhost with an SSH tunnel
