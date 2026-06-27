# newbtccollector

Private BTCUSDT 5 minute market collector and dashboard.

This repo intentionally uses plain JavaScript. It does not use TypeScript, Docker, scheduled backup jobs, or SSH tunnels.

## What is included

- Next.js dashboard in `app/`
- Separate Node collector in `collector/collector.mjs`
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

## Collector schedule

Each BTCUSDT market is a 5 minute UTC window.

- Every 5 seconds from 0s through 275s
- Every 1 second from 280s through 299s
- One close sample at exactly 300s

The close sample for one window is also the open sample for the next window when the collector is running continuously.

## Database tables

- `markets`
- `price_samples`
- `market_labels`
- `collector_heartbeats`
- `collection_errors`

`npm run db:setup` creates the core PostgreSQL schema. If TimescaleDB is installed, it also converts `price_samples` into a hypertable.

## Health endpoint

```text
/api/health
```

Returns database configuration status, latest collector heartbeat, and 24 hour market counts.
