# Droplet Operations

These notes are for a plain DigitalOcean Droplet running PostgreSQL and the BTC collector. The Next dashboard does not need to run on the Droplet.

This project intentionally avoids TypeScript, Docker, and scheduled backup jobs. Local dashboard access uses an SSH tunnel so PostgreSQL can stay private on the Droplet.

## Server Layout

```text
/opt/newbtccollector        app checkout
/opt/newbtccollector/.env   production environment file
PostgreSQL                  local database on 127.0.0.1:5432
systemd                     keeps the collector running
```

The Droplet is responsible for:

```text
PostgreSQL
collector process
```

The Droplet is not required for:

```text
Next dashboard hosting
```

## 1. New Droplet Setup

Run these commands as `root` on a fresh Ubuntu Droplet.

Install system packages, Node, npm, Git, and PostgreSQL:

```bash
apt update
apt install -y curl git ca-certificates openssl postgresql postgresql-contrib

curl -fsSL https://deb.nodesource.com/setup_22.x -o nodesource_setup.sh
bash nodesource_setup.sh
apt install -y nodejs

node -v
npm -v
```

Do not install npm by itself with `apt install npm`; it can install an old Node/npm combination.

Clone the repo:

```bash
git clone https://github.com/9r89uf8/newbtccollectorgit.git /opt/newbtccollector
cd /opt/newbtccollector
```

Create the database and database user:

```bash
systemctl enable --now postgresql

DBPASS=$(openssl rand -hex 24)
echo "SAVE THIS DB PASSWORD: $DBPASS"

sudo -u postgres psql -c "CREATE USER btc_collector WITH PASSWORD '$DBPASS';"
sudo -u postgres psql -c "CREATE DATABASE btc_collector OWNER btc_collector;"
```

Create the production env file:

```bash
cd /opt/newbtccollector
cp .env.example .env
nano .env
```

Use the password printed above:

```bash
DATABASE_URL=postgres://btc_collector:PASTE_PASSWORD_HERE@127.0.0.1:5432/btc_collector
PGSSL=false

COLLECTOR_NAME=btc-price-collector
COLLECTOR_SYMBOL=BTCUSDT
BINANCE_TIMEOUT_MS=4000
ENABLE_FUTURES_MICROSTRUCTURE=true
LARGE_TRADE_QUOTE_THRESHOLD=1000000
MAX_AGG_TRADE_PAGES_PER_MARKET=30
```

Save nano with `Ctrl+O`, `Enter`, then `Ctrl+X`.

Install dependencies and create the database tables:

```bash
cd /opt/newbtccollector
npm install
unset DATABASE_URL
npm run db:setup
```

`npm run db:setup` may print:

```text
TimescaleDB not enabled. Core PostgreSQL schema is ready.
```

That is acceptable for V1. The collector works with plain PostgreSQL.

Run a foreground collector test:

```bash
npm run collector
```

It should print:

```text
btc-price-collector starting for BTCUSDT
```

That process keeps running in the terminal. Open a second Droplet terminal and verify rows:

```bash
sudo -u postgres psql -d btc_collector -c "select source, count(*), max(scheduled_at) from price_samples group by source;"
sudo -u postgres psql -d btc_collector -c "select time, source, error_type, message from collection_errors order by time desc limit 10;"
```

If Binance returns `HTTP 451`, the Droplet region is blocked by Binance. Use a region where the endpoints are reachable, or switch the collector to different data sources.

Stop the foreground collector with `Ctrl+C` before installing the service.

## 2. Run The Collector As A Service

Create a service user and install the systemd unit:

```bash
cd /opt/newbtccollector

id btc || useradd --system --home /opt/newbtccollector --shell /usr/sbin/nologin btc
chown -R btc:btc /opt/newbtccollector
chmod 600 /opt/newbtccollector/.env

cp ops/systemd/newbtccollector-collector.service /etc/systemd/system/newbtccollector-collector.service

systemctl daemon-reload
systemctl enable --now newbtccollector-collector
```

Check service status:

```bash
systemctl status newbtccollector-collector --no-pager
journalctl -u newbtccollector-collector -f
```

Verify data is still being written:

```bash
sudo -u postgres psql -d btc_collector -c "select source, count(*), max(scheduled_at) from price_samples group by source;"
sudo -u postgres psql -d btc_collector -c "select collector_name, status, last_seen_at, current_market_id, message from collector_heartbeats;"
```

Useful service commands:

```bash
systemctl restart newbtccollector-collector
systemctl stop newbtccollector-collector
systemctl start newbtccollector-collector
systemctl status newbtccollector-collector --no-pager
```

## 3. Deploy Code Changes And Restart

Make code changes locally, commit them, and push them to GitHub. Then run one SSH command from your laptop.

From PowerShell or another local terminal:

```bash
ssh root@DROPLET_PUBLIC_IPV4 "cd /opt/newbtccollector && bash scripts/deploy.sh"
```

The first time you use this after adding `scripts/deploy.sh`, the Droplet may not have the script yet. Bootstrap it once with:

```bash
ssh root@DROPLET_PUBLIC_IPV4 "cd /opt/newbtccollector && git pull --ff-only && bash scripts/deploy.sh"
```

If your SSH key is not the default key, pass it explicitly:

```bash
ssh -i C:\path\to\your\key root@DROPLET_PUBLIC_IPV4 "cd /opt/newbtccollector && bash scripts/deploy.sh"
```

The deploy script does this on the Droplet:

```text
fetch origin/main
fast-forward merge if there are new commits
npm install
npm run db:setup
copy the collector systemd unit
systemctl daemon-reload
systemctl restart newbtccollector-collector
show service status
```

The script intentionally refuses to deploy if tracked files are dirty on the Droplet. That prevents a deploy from silently overwriting manual edits.

You can also run the script while already logged into the Droplet:

```bash
cd /opt/newbtccollector
bash scripts/deploy.sh
```

Watch logs after deploy:

```bash
journalctl -u newbtccollector-collector -f
```

Verify rows after a minute:

```bash
sudo -u postgres psql -d btc_collector -c "select source, count(*), max(scheduled_at) from price_samples group by source;"
sudo -u postgres psql -d btc_collector -c "select time, source, error_type, message from collection_errors order by time desc limit 10;"
```

If only `.env` changed, no Git deploy is needed:

```bash
nano /opt/newbtccollector/.env
systemctl restart newbtccollector-collector
```
## 4. Read Droplet DB From Localhost With SSH Tunnel

The local Next dashboard can read the Droplet PostgreSQL database through an SSH tunnel. This is preferred over opening PostgreSQL port `5432` to the internet.

With this setup:

```text
Laptop localhost:5433 -> SSH tunnel -> Droplet 127.0.0.1:5432 -> PostgreSQL
```

PostgreSQL stays bound to the Droplet's local interface, and the only public access path is normal SSH.

### On the Droplet

No PostgreSQL network exposure is needed. Confirm Postgres is reachable locally:

```bash
sudo -u postgres psql -d btc_collector -c "select count(*) from price_samples;"
```

The collector service should keep using the Droplet-local database URL:

```bash
DATABASE_URL=postgres://btc_collector:DB_PASSWORD@127.0.0.1:5432/btc_collector
PGSSL=false
```

### On your laptop

Open a terminal and start the tunnel:

```bash
ssh -N -L 5433:127.0.0.1:5432 root@DROPLET_PUBLIC_IPV4
```

Keep that terminal open while using the dashboard.

If your SSH key is not the default key, pass it explicitly:

```bash
ssh -i C:\path\to\your\key -N -L 5433:127.0.0.1:5432 root@DROPLET_PUBLIC_IPV4
```

Use local port `5433` instead of `5432` so it does not conflict with any Postgres instance on your laptop.

### Local dashboard env

In your local project `.env`, point the dashboard at the tunnel:

```bash
DATABASE_URL=postgres://btc_collector:DB_PASSWORD@127.0.0.1:5433/btc_collector
PGSSL=false
```

Then run the dashboard locally:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

### Quick test

If `psql` is installed on your laptop, test the tunnel directly:

```bash
psql "postgres://btc_collector:DB_PASSWORD@127.0.0.1:5433/btc_collector" -c "select current_database(), current_user;"
```

If `psql` is not installed, start `npm run dev` and open `/api/health`:

```text
http://localhost:3000/api/health
```

A working connection returns `"ok": true`.

### Troubleshooting

If the dashboard cannot connect:

- confirm the SSH tunnel terminal is still open
- confirm the Droplet IP is correct
- confirm the DB password matches `/opt/newbtccollector/.env` on the Droplet
- confirm local `.env` uses port `5433`, not `5432`
- confirm the collector service is still running on the Droplet

Useful Droplet checks:

```bash
systemctl status newbtccollector-collector --no-pager
systemctl status postgresql --no-pager
sudo -u postgres psql -d btc_collector -c "select source, count(*), max(scheduled_at) from price_samples group by source;"
```
