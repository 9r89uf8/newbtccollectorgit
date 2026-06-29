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
          select
            m.id,
            m.symbol,
            m.start_time,
            m.end_time,
            m.status,
            coalesce(
              json_agg(
                json_build_object(
                  'source', ml.source,
                  'quality', ml.quality,
                  'direction', ml.direction,
                  'sample_count', ml.sample_count
                )
                order by ml.source
              ) filter (where ml.source is not null),
              '[]'::json
            ) as labels
          from markets m
          left join market_labels ml on ml.market_id = m.id
          where m.start_time >= ($1::date::timestamp at time zone 'UTC')
            and m.start_time < (($1::date + interval '1 day')::timestamp at time zone 'UTC')
          group by m.id
          order by m.start_time asc
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