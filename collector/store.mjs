import { query } from "../lib/db.js";

export async function upsertMarket(market) {
  await query(
    `
      insert into markets (id, symbol, start_time, end_time, status)
      values ($1, $2, $3, $4, 'open')
      on conflict (id) do nothing
    `,
    [market.id, market.symbol, market.start, market.end]
  );
}

export async function heartbeat(collectorName, status, marketId, message = null) {
  await query(
    `
      insert into collector_heartbeats
        (collector_name, last_seen_at, current_market_id, status, message, updated_at)
      values ($1, now(), $2, $3, $4, now())
      on conflict (collector_name) do update set
        last_seen_at = excluded.last_seen_at,
        current_market_id = excluded.current_market_id,
        status = excluded.status,
        message = excluded.message,
        updated_at = now()
    `,
    [collectorName, marketId, status, message]
  );
}

export async function recordError({ marketId, source, errorType, message, retryCount = 0 }) {
  await query(
    `
      insert into collection_errors (market_id, source, error_type, message, retry_count)
      values ($1, $2, $3, $4, $5)
    `,
    [marketId, source, errorType, String(message).slice(0, 500), retryCount]
  );
}

export async function updateMarketStatus(marketId, status) {
  await query(
    `
      update markets
      set status = $2, closed_at = now()
      where id = $1
    `,
    [marketId, status]
  );
}

export async function markMarketIncomplete(marketId) {
  const result = await query(
    `
      update markets
      set status = 'incomplete'
      where id = $1
        and status = 'open'
        and closed_at is null
      returning id
    `,
    [marketId]
  );

  return result.rowCount > 0;
}

export async function getMarketStatus(marketId) {
  const result = await query(
    `
      select status
      from markets
      where id = $1
      limit 1
    `,
    [marketId]
  );

  return result.rows[0]?.status || null;
}

export async function getDueOpenMarkets(limit = 10) {
  const result = await query(
    `
      select id, symbol, start_time, end_time
      from markets
      where status in ('open', 'incomplete')
        and end_time <= now()
        and closed_at is null
      order by end_time asc
      limit $1
    `,
    [limit]
  );

  return result.rows.map((row) => ({
    id: row.id,
    symbol: row.symbol,
    start: new Date(row.start_time),
    end: new Date(row.end_time),
    startMs: new Date(row.start_time).getTime(),
    endMs: new Date(row.end_time).getTime(),
  }));
}
