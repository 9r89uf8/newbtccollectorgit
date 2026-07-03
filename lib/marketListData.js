import { hasDatabaseConfig, query } from "./db.js";

function sanitizeError(error) {
  if (!error) return "Unknown database error";
  return error.message || String(error);
}

function emptyMarketListData(configured, ok, error, day) {
  return {
    configured,
    ok,
    error,
    day,
    markets: [],
    summary: null,
  };
}

export function normalizeUtcDay(value) {
  const day = typeof value === "string" ? value : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  return new Date().toISOString().slice(0, 10);
}

export async function getMarketsForUtcDay(dayValue) {
  const day = normalizeUtcDay(dayValue);

  if (!hasDatabaseConfig()) {
    return emptyMarketListData(false, false, "DATABASE_URL is not configured.", day);
  }

  try {
    const [markets, summary] = await Promise.all([
      query(
        `
          with day_markets as (
            select id, symbol, start_time, end_time, status
            from markets
            where start_time >= ($1::date::timestamp at time zone 'UTC')
              and start_time < (($1::date + interval '1 day')::timestamp at time zone 'UTC')
          ),
          market_labels_json as (
            select
              ml.market_id,
              json_agg(
                json_build_object(
                  'source', ml.source,
                  'quality', ml.quality,
                  'direction', ml.direction,
                  'sample_count', ml.sample_count
                )
                order by ml.source
              ) as labels
            from market_labels ml
            join day_markets dm on dm.id = ml.market_id
            group by ml.market_id
          )
          select
            dm.id,
            dm.symbol,
            dm.start_time,
            dm.end_time,
            dm.status,
            pr.binance_futures_open_price,
            pr.binance_futures_close_price,
            pr.binance_futures_return_pct,
            pr.binance_futures_direction,
            pr.binance_futures_quality,
            pr.polymarket_open_price,
            pr.polymarket_close_price,
            pr.polymarket_return_pct,
            pr.polymarket_direction,
            pr.polymarket_winning_outcome,
            pr.polymarket_closed,
            pr.polymarket_gamma_status,
            pr.polymarket_slug,
            coalesce(mlj.labels, '[]'::json) as labels
          from day_markets dm
          left join market_labels_json mlj on mlj.market_id = dm.id
          left join market_price_references pr on pr.market_id = dm.id
          order by dm.start_time asc
        `,
        [day]
      ),
      query(
        `
          select
            count(*)::int as markets_total,
            (count(*) filter (where status = 'closed'))::int as closed_count,
            (count(*) filter (where status = 'open'))::int as open_count,
            (count(*) filter (where status = 'incomplete'))::int as incomplete_count
          from markets
          where start_time >= ($1::date::timestamp at time zone 'UTC')
            and start_time < (($1::date + interval '1 day')::timestamp at time zone 'UTC')
        `,
        [day]
      ),
    ]);

    return {
      configured: true,
      ok: true,
      error: null,
      day,
      markets: markets.rows,
      summary: summary.rows[0] || null,
    };
  } catch (error) {
    return emptyMarketListData(true, false, sanitizeError(error), day);
  }
}