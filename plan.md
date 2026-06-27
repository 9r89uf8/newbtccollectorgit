Yes — the first version should be **simple, cheap, and expandable**.

My recommendation:

> **Next.js dashboard + separate TypeScript collector + PostgreSQL/TimescaleDB database + Docker + DigitalOcean Droplet later**

For your current plan, I would **not** start with ClickHouse, Convex, Firebase, MongoDB, or a complex data pipeline.

## The best database choice: PostgreSQL + TimescaleDB

Use **PostgreSQL with the TimescaleDB extension**.

TimescaleDB is basically PostgreSQL optimized for time-series/event data. It gives you normal SQL, relational tables, joins, indexes, and also time-series features like hypertables and continuous aggregates. Timescale’s docs describe hypertables as PostgreSQL tables with special features for real-time analytics on time-series data, and continuous aggregates as analytic summaries that refresh as new data arrives. ([TigerData][1])

That fits your project really well because you have two types of data:

1. **Market windows** — relational data: market id, symbol, start, end, status, labels.
2. **Price samples** — time-series data: timestamp, source, symbol, price.

Your current sample rate is tiny by database standards. Based on your schedule, each 5-minute market has roughly:

| Item                                               |               Count |
| -------------------------------------------------- | ------------------: |
| Normal samples from `0s` to `275s`, every 5s       |                  56 |
| Final-ramp samples from `280s` to `300s`, every 1s |                  21 |
| Total per source                                   |                  77 |
| Spot + futures                                     | 154 rows per market |
| Markets per day                                    |                 288 |
| Rows per day                                       |             ~44,352 |
| Rows per year                                      |       ~16.2 million |

That is very manageable for PostgreSQL/TimescaleDB.

## Recommended V1 architecture

```text
Binance Spot API      Binance Futures API
       │                     │
       └────── Collector Worker ──────┐
                                      │
                              PostgreSQL + TimescaleDB
                                      │
                                  Next.js app
                                      │
                              localhost dashboard
```

The important thing: **the collector should not live inside the Next.js app**.

Next.js should be your private dashboard and query layer. The collector should be a separate long-running process whose only job is to create markets, collect samples, close markets, and write labels.

## Data source for V1

For minimum collection, use only latest price endpoints:

| Source                 | Endpoint                    | Purpose                            |
| ---------------------- | --------------------------- | ---------------------------------- |
| Binance Spot           | `GET /api/v3/ticker/price`  | Latest spot price for `BTCUSDT`    |
| Binance USDⓈ-M Futures | `GET /fapi/v2/ticker/price` | Latest futures price for `BTCUSDT` |

Binance’s Spot docs list `GET /api/v3/ticker/price` as the “latest price for a symbol or symbols.” ([Binance Developer Center][2]) Binance’s USDⓈ-M Futures docs list `GET /fapi/v2/ticker/price` as the latest price endpoint, and the futures response includes a `time` field for transaction time. ([Binance Developer Center][3])

For V1, collect:

| Field         | Example                                  |
| ------------- | ---------------------------------------- |
| source        | `binance_spot`, `binance_futures`        |
| symbol        | `BTCUSDT`                                |
| scheduled_at  | `2026-06-26T21:05:05Z`                   |
| collected_at  | actual time your server received it      |
| exchange_time | available for futures, nullable for spot |
| price         | `65865.12`                               |
| latency_ms    | request duration                         |
| sample_type   | `normal`, `final_ramp`, `close`          |

That is enough to start finding basic patterns.

## Important schema decision: do not physically store samples “inside” a market

Your market structure is right conceptually, but I would store it like this:

```text
markets table
price_samples table
market_labels table
collector_heartbeats table
collection_errors table
```

Instead of making every sample belong permanently to one market, store price samples globally by timestamp.

Why? Because this timestamp:

```text
4:10:00 PM
```

is both:

```text
close of Market #108392
open of Market #108393
```

So the clean design is:

```text
Market #108392 = 4:05:00 through 4:10:00
Market #108393 = 4:10:00 through 4:15:00
```

The same `4:10:00` price sample can be used as the previous market’s close and the next market’s open. You avoid duplicate data and weird inconsistencies.

## Suggested database model

### 1. `markets`

This defines the 5-minute windows.

| Field      | Example                        |
| ---------- | ------------------------------ |
| id         | `2026-06-26T21:05:00Z_BTCUSDT` |
| symbol     | `BTCUSDT`                      |
| start_time | `2026-06-26T21:05:00Z`         |
| end_time   | `2026-06-26T21:10:00Z`         |
| status     | `open`, `closed`, `incomplete` |
| created_at | timestamp                      |
| closed_at  | timestamp                      |

I would store times in **UTC** only. The dashboard can display them in your local time.

### 2. `price_samples`

This is the main time-series table.

| Field           | Example                    |
| --------------- | -------------------------- |
| scheduled_at    | `2026-06-26T21:09:41Z`     |
| collected_at    | `2026-06-26T21:09:41.142Z` |
| source          | `binance_spot`             |
| instrument_type | `spot`                     |
| symbol          | `BTCUSDT`                  |
| price_type      | `last`                     |
| price           | `65865.12`                 |
| exchange_time   | nullable                   |
| latency_ms      | `142`                      |
| sample_type     | `final_ramp`               |

This table should be a **TimescaleDB hypertable**.

### 3. `market_labels`

This stores the result after a market closes.

Instead of putting only one `open_price` and `close_price` directly on `markets`, I would make labels per source.

| Field        | Example                        |
| ------------ | ------------------------------ |
| market_id    | `2026-06-26T21:05:00Z_BTCUSDT` |
| source       | `binance_spot`                 |
| open_price   | `65865.00`                     |
| close_price  | `65912.50`                     |
| return_pct   | `0.0721`                       |
| direction    | `up`                           |
| sample_count | `77`                           |
| quality      | `complete`                     |

Then another row:

| Field        | Example                        |
| ------------ | ------------------------------ |
| market_id    | `2026-06-26T21:05:00Z_BTCUSDT` |
| source       | `binance_futures`              |
| open_price   | `65867.10`                     |
| close_price  | `65915.80`                     |
| return_pct   | `0.0739`                       |
| direction    | `up`                           |
| sample_count | `77`                           |
| quality      | `complete`                     |

This makes it easy later to add:

```text
coinbase_spot
kraken_spot
binance_mark_price
binance_book_mid
```

without changing the whole schema.

### 4. `collector_heartbeats`

This tells your dashboard whether the collector is alive.

| Field             | Example                      |
| ----------------- | ---------------------------- |
| collector_name    | `btc-price-collector`        |
| last_seen_at      | timestamp                    |
| current_market_id | market id                    |
| status            | `running`, `paused`, `error` |

### 5. `collection_errors`

This saves API/network issues.

| Field       | Example        |
| ----------- | -------------- |
| time        | timestamp      |
| market_id   | nullable       |
| source      | `binance_spot` |
| error_type  | `timeout`      |
| message     | short message  |
| retry_count | number         |

This will matter a lot once it runs 24/7.

## V1 tech stack

| Layer                   | Use                                                        |
| ----------------------- | ---------------------------------------------------------- |
| Frontend/dashboard      | **Next.js + TypeScript**                                   |
| Styling                 | Tailwind, shadcn/ui, or simple CSS                         |
| Charts                  | Lightweight charting library later                         |
| API/query layer         | Next.js Route Handlers or server components                |
| Collector               | Separate **TypeScript Node.js worker**                     |
| Database                | **PostgreSQL + TimescaleDB**                               |
| Local environment       | Docker Compose                                             |
| Production/private 24/7 | DigitalOcean Droplet                                       |
| Process management      | Docker restart policy, systemd, or PM2                     |
| Backups                 | nightly `pg_dump`, volume snapshots, or managed DB backups |

Next.js can be self-hosted on a Node.js server or Docker image, and its docs recommend using a reverse proxy like nginx if exposing it to the internet. In your case, because this is private, I would avoid exposing it publicly at all. ([Next.js][4])

## Local-first setup

For development on your computer:

```text
localhost:3000       Next.js dashboard
localhost:5432       PostgreSQL/TimescaleDB
collector process    runs locally
```

Use Docker Compose so the whole thing is reproducible.

Services:

```text
next-app
collector
postgres-timescale
```

Even locally, keep the collector separate from Next.js.

## 24/7 setup on DigitalOcean

For the 24/7 collector, DigitalOcean is a good fit.

Use a **Droplet** first. DigitalOcean describes Droplets as their virtual machines, and they are simple enough for this kind of always-on private app. ([DigitalOcean][5])

Recommended first production layout:

```text
DigitalOcean Droplet
│
├── PostgreSQL + TimescaleDB container
├── Collector container
├── Next.js container
└── Optional nginx container
```

Then access your dashboard privately using either:

```text
SSH tunnel
```

or:

```text
Tailscale
```

For example, the app can run on the Droplet, but you open it from your laptop as:

```text
localhost:3000
```

through an SSH tunnel. That way the website is still “local” to you and not published publicly.

## Self-hosted DB vs managed DB

You have two realistic options.

### Option A — cheapest: self-host PostgreSQL/TimescaleDB on the Droplet

This is what I would do first.

Pros:

| Pro          | Why it matters                                           |
| ------------ | -------------------------------------------------------- |
| Cheaper      | One VPS can run DB, collector, and dashboard             |
| Full control | Easier to install TimescaleDB, tune storage, export data |
| Simple       | Good for a private research project                      |

Cons:

| Con                 | Why it matters                                           |
| ------------------- | -------------------------------------------------------- |
| You manage backups  | Very important                                           |
| You manage upgrades | PostgreSQL/Timescale updates are on you                  |
| One machine risk    | If the Droplet dies and you have no backup, data is gone |

### Option B — easier maintenance: DigitalOcean Managed PostgreSQL

DigitalOcean’s managed PostgreSQL supports PostgreSQL extensions, and their docs list `timescaledb` as a supported extension. ([DigitalOcean Docs][6]) DigitalOcean’s PostgreSQL pricing docs say single-node managed clusters begin at $15/month, with high-availability clusters starting higher. ([DigitalOcean Docs][7])

Pros:

| Pro                 | Why it matters                |
| ------------------- | ----------------------------- |
| Managed backups     | Less operational stress       |
| Easier recovery     | Better than one unmanaged VPS |
| Less DB maintenance | You focus on data/app         |

Cons:

| Con                      | Why it matters                                |
| ------------------------ | --------------------------------------------- |
| More expensive           | App Droplet + managed DB                      |
| Less control             | Managed extension/version limitations         |
| Might still need Droplet | Collector and dashboard need somewhere to run |

Given Convex got too expensive, I’d start with **Option A** and add disciplined backups.

## Why not ClickHouse yet?

ClickHouse is excellent, but I would not start there.

ClickHouse’s MergeTree engines are designed for high ingest rates and huge data volumes, which is great if you later collect order books, trades, liquidations, and many symbols at high frequency. ([ClickHouse][8])

But for V1, ClickHouse is more complexity than you need.

Start with:

```text
PostgreSQL + TimescaleDB
```

Later, if you grow into billions of rows or heavy analytics, add:

```text
ClickHouse as analytics warehouse
```

You can keep Postgres/Timescale as the app database and send heavier historical data into ClickHouse later.

## What I would build first

### Phase 1: minimum useful version

Collect only:

```text
BTCUSDT spot last price
BTCUSDT futures last price
```

Schedule:

```text
Every 5 seconds for first 4m40s
Every 1 second for final 20s
Close/label at exact 5-minute boundary
```

Dashboard pages:

| Page          | Purpose                                        |
| ------------- | ---------------------------------------------- |
| Markets list  | See all 5-minute markets                       |
| Market detail | Chart spot vs futures inside one market        |
| Latest status | Collector alive/dead, current market           |
| Basic stats   | Up/down count, average return, missing samples |

### Phase 2: better interpretation

Add calculated features, not new raw data yet:

```text
spot return
futures return
basis = futures - spot
basis_pct
max move inside market
min move inside market
final_20s momentum
volatility inside market
```

### Phase 3: add more data only when needed

Then consider adding:

```text
best bid/ask
spread
mark price
funding rate
open interest
recent trades
liquidations
order book depth
```

Do not add all of that now.

## My recommended final stack

For your exact use case, I’d choose:

```text
Next.js + TypeScript
Node.js TypeScript collector
PostgreSQL + TimescaleDB
Docker Compose
DigitalOcean Droplet
SSH tunnel or Tailscale for private access
Nightly database backups
```

And the database should be shaped like:

```text
markets
price_samples
market_labels
collector_heartbeats
collection_errors
```

The main rule: **collect raw prices cleanly first, then derive patterns later**. Do not overbuild the collector yet. The value will come from having clean, timestamped, uninterrupted data over days and weeks.

[1]: https://www.tigerdata.com/docs/learn/hypertables/understand-hypertables?utm_source=chatgpt.com "Understand hypertables | Tiger Data Docs"
[2]: https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints "Market Data endpoints | Binance Open Platform"
[3]: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Symbol-Price-Ticker-v2 "Symbol Price Ticker V2 | Binance Open Platform"
[4]: https://nextjs.org/docs/app/guides/self-hosting?utm_source=chatgpt.com "Guides: Self-Hosting"
[5]: https://www.digitalocean.com/products/droplets?utm_source=chatgpt.com "Virtual machines for every use case"
[6]: https://docs.digitalocean.com/products/databases/postgresql/details/supported-extensions/?utm_source=chatgpt.com "Supported PostgreSQL Extensions"
[7]: https://docs.digitalocean.com/products/databases/postgresql/details/pricing/ "PostgreSQL Pricing | DigitalOcean Documentation"
[8]: https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree?utm_source=chatgpt.com "MergeTree table engine | ClickHouse Docs"
