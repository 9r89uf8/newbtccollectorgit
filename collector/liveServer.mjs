import http from "node:http";
import {
  ENABLE_LIVE_DASHBOARD,
  LIVE_DASHBOARD_BROADCAST_MS,
  LIVE_DASHBOARD_HOST,
  LIVE_DASHBOARD_PORT,
} from "./config.mjs";
import { getPublicLiveSnapshot } from "./liveState.mjs";
import { recordError } from "./store.mjs";

function writeSse(res, eventName, data) {
  if (eventName) res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function startLiveDashboardServer() {
  if (!ENABLE_LIVE_DASHBOARD) return { stop() {} };

  const clients = new Set();
  let broadcastTimer = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${LIVE_DASHBOARD_HOST}:${LIVE_DASHBOARD_PORT}`);

    if (url.pathname === "/snapshot") {
      const body = JSON.stringify(getPublicLiveSnapshot());
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }

    if (url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "connection": "keep-alive",
        "x-accel-buffering": "no",
      });
      clients.add(res);
      writeSse(res, "snapshot", getPublicLiveSnapshot());
      req.on("close", () => {
        clients.delete(res);
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });

  server.on("error", (error) => {
    recordError({
      marketId: null,
      source: "live_dashboard_api",
      errorType: "live_dashboard_server_error",
      message: error.message || String(error),
    }).catch(() => {});
  });

  server.listen(LIVE_DASHBOARD_PORT, LIVE_DASHBOARD_HOST, () => {
    console.log(`live dashboard API listening on http://${LIVE_DASHBOARD_HOST}:${LIVE_DASHBOARD_PORT}`);
  });

  broadcastTimer = setInterval(() => {
    if (clients.size === 0) return;
    const snapshot = getPublicLiveSnapshot();
    for (const client of clients) {
      writeSse(client, "snapshot", snapshot);
    }
  }, LIVE_DASHBOARD_BROADCAST_MS);
  broadcastTimer.unref?.();

  return {
    async stop() {
      if (broadcastTimer) clearInterval(broadcastTimer);
      for (const client of clients) {
        client.end();
      }
      clients.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
