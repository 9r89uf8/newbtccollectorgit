# Deployment Notes

These notes are for a plain DigitalOcean Droplet deployment without Docker and without SSH tunnel setup.

## Expected server layout

```text
/opt/newbtccollector        app checkout
/opt/newbtccollector/.env   production environment file
```

The `.env` file on the Droplet needs at least:

```bash
DATABASE_URL=postgres://btc_collector:change-me@127.0.0.1:5432/btc_collector
PGSSL=false
COLLECTOR_NAME=btc-price-collector
COLLECTOR_SYMBOL=BTCUSDT
BINANCE_TIMEOUT_MS=4000
PORT=3000
```

## First deploy flow

```bash
git clone <your-github-repo-url> /opt/newbtccollector
cd /opt/newbtccollector
npm install
npm run db:setup
npm run build
```

Then copy the service templates from `ops/systemd/` into `/etc/systemd/system/`, adjust `User`, `WorkingDirectory`, `EnvironmentFile`, and the `npm` path if needed.

```bash
systemctl daemon-reload
systemctl enable --now newbtccollector-web
systemctl enable --now newbtccollector-collector
```

Check status:

```bash
systemctl status newbtccollector-web
systemctl status newbtccollector-collector
journalctl -u newbtccollector-collector -f
```

## Network posture

The app binds through Next.js. Keep firewall rules tight and expose only what you intentionally want reachable. These repo files do not set up Docker, an SSH tunnel, or scheduled backup jobs.
