import { hasDatabaseConfig, query } from "@/lib/db.js";

export const LIVE_COLLECTOR_URL = (process.env.LIVE_COLLECTOR_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");

const priceToBeatCache = new Map();

function readNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function unavailableSnapshot(message) {
  return {
    ok: false,
    degraded: true,
    error: message || "live collector unavailable",
    collector: {
      snapshotTs: new Date().toISOString(),
      staleSources: ["collector_api"],
    },
  };
}

async function loadPriceToBeat(marketId) {
  if (!marketId || !hasDatabaseConfig()) return null;
  if (priceToBeatCache.has(marketId)) return priceToBeatCache.get(marketId);

  const result = await query(
    `
      select price, source
      from (
        select price_to_beat::float8 as price, 'gamma'::text as source, 0 as priority
        from polymarket_5m_btc_markets
        where market_id = $1
          and price_to_beat is not null
        union all
        select price::float8 as price, 'chainlink_open'::text as source, 1 as priority
        from (
          select price
          from chainlink_btc_price_samples
          where market_id = $1
            and price is not null
          order by scheduled_at asc
          limit 1
        ) chainlink_open
      ) candidates
      order by priority asc
      limit 1
    `,
    [marketId]
  );

  const row = result.rows[0];
  const price = readNumber(row?.price);
  if (price === null) return null;

  const value = {
    price,
    source: row.source || "fallback",
  };
  priceToBeatCache.set(marketId, value);
  return value;
}

export async function withPriceToBeatFallback(snapshot) {
  if (!snapshot || snapshot.ok === false) return snapshot;
  if (readNumber(snapshot.polymarket?.priceToBeat) !== null) return snapshot;

  const marketId = snapshot.market?.id;
  if (!marketId) return snapshot;

  try {
    const fallback = await loadPriceToBeat(marketId);
    if (!fallback) return snapshot;

    return {
      ...snapshot,
      polymarket: {
        ...(snapshot.polymarket || {}),
        priceToBeat: fallback.price,
        priceToBeatSource: fallback.source,
      },
    };
  } catch {
    return snapshot;
  }
}

export async function loadPersistedLiveSnapshot() {
  if (!hasDatabaseConfig()) return null;

  const result = await query(
    `
      select payload, updated_at
      from live_state
      where key = 'latest'
      limit 1
    `
  );

  const row = result.rows[0];
  if (!row?.payload) return null;

  const payload = row.payload;
  const collector = payload.collector || {};
  const staleSources = new Set(collector.staleSources || []);
  staleSources.add("collector_api");

  return withPriceToBeatFallback({
    ...payload,
    degraded: true,
    collector: {
      ...collector,
      staleSources: [...staleSources],
      persistedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      proxyWarning: "collector API unavailable; using latest persisted live_state row",
    },
  });
}

export async function getSnapshotFallback(message) {
  try {
    const persisted = await loadPersistedLiveSnapshot();
    return persisted || unavailableSnapshot(message);
  } catch (error) {
    return unavailableSnapshot(error.message || String(error));
  }
}