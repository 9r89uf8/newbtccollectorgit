import { hasDatabaseConfig, query } from "./db.js";

function sanitizeError(error) {
  if (!error) return "Unknown database error";
  return error.message || String(error);
}

function emptyDashboardData(configured, ok, error) {
  return {
    configured,
    ok,
    error,
    heartbeat: null,
    recentMarkets: [],
    latestSamples: [],
    recentErrors: [],
    stats: null,
    sourceStats: [],
    directionStats: [],
    dailyMarketCounts: [],
  };
}

export async function getDashboardData() {
  if (!hasDatabaseConfig()) {
    return emptyDashboardData(false, false, "DATABASE_URL is not configured.");
  }

  try {
    const [
      heartbeat,
      recentMarkets,
      latestSamples,
      recentErrors,
      stats,
      sourceStats,
      directionStats,
      dailyMarketCounts,
    ] = await Promise.all([
      query(`
        select collector_name, last_seen_at, current_market_id, status, message
        from collector_heartbeats
        order by last_seen_at desc
        limit 1
      `),
      query(`
        with recent_markets as (
          select id, symbol, start_time, end_time, status
          from markets
          order by start_time desc
          limit 3
        ),
        market_labels_json as (
          select
            ml.market_id,
            json_agg(
              json_build_object(
                'source', ml.source,
                'open_price', ml.open_price,
                'close_price', ml.close_price,
                'return_pct', ml.return_pct,
                'direction', ml.direction,
                'sample_count', ml.sample_count,
                'quality', ml.quality
              )
              order by ml.source
            ) as labels
          from market_labels ml
          join recent_markets rm on rm.id = ml.market_id
          group by ml.market_id
        )
        select
          rm.id,
          rm.symbol,
          rm.start_time,
          rm.end_time,
          rm.status,
          pr.binance_spot_open_price,
          pr.binance_spot_close_price,
          pr.binance_spot_return_pct,
          pr.binance_spot_direction,
          pr.binance_spot_quality,
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
        from recent_markets rm
        left join market_labels_json mlj on mlj.market_id = rm.id
        left join market_price_references pr on pr.market_id = rm.id
        order by rm.start_time desc
      `),
      query(`
        select distinct on (source)
          source, symbol, price, scheduled_at, collected_at, latency_ms, sample_type
        from price_samples
        order by source, scheduled_at desc, collected_at desc
      `),
      query(`
        select time, market_id, source, error_type, message, retry_count
        from collection_errors
        order by time desc
        limit 8
      `),
      query(`
        select
          count(*)::int as markets_total,
          count(*) filter (where status = 'open')::int as markets_open,
          count(*) filter (where status = 'closed')::int as markets_closed,
          count(*) filter (where status = 'incomplete')::int as markets_incomplete
        from markets
        where start_time >= now() - interval '24 hours'
      `),
      query(`
        select
          source,
          count(*)::int as samples,
          max(scheduled_at) as latest_sample_at,
          round(avg(latency_ms))::int as avg_latency_ms
        from price_samples
        where scheduled_at >= now() - interval '1 hour'
        group by source
        order by source
      `),
      query(`
        select source, direction, count(*)::int as count
        from market_labels
        where created_at >= now() - interval '24 hours'
        group by source, direction
        order by source, direction
      `),
      query(`
        with days as (
          select generate_series(
            date '2026-06-27',
            (now() at time zone 'UTC')::date,
            interval '1 day'
          )::date as market_day
        )
        select
          d.market_day::text as market_day,
          count(m.id)::int as markets_total,
          (count(m.id) filter (where m.status = 'closed'))::int as closed_count,
          (count(m.id) filter (where m.status = 'open'))::int as open_count,
          (count(m.id) filter (where m.status = 'incomplete'))::int as incomplete_count
        from days d
        left join markets m
          on m.start_time >= (d.market_day::timestamp at time zone 'UTC')
         and m.start_time < ((d.market_day + interval '1 day')::timestamp at time zone 'UTC')
        group by d.market_day
        order by d.market_day desc
      `),
    ]);

    return {
      configured: true,
      ok: true,
      error: null,
      heartbeat: heartbeat.rows[0] || null,
      recentMarkets: recentMarkets.rows,
      latestSamples: latestSamples.rows,
      recentErrors: recentErrors.rows,
      stats: stats.rows[0] || null,
      sourceStats: sourceStats.rows,
      directionStats: directionStats.rows,
      dailyMarketCounts: dailyMarketCounts.rows,
    };
  } catch (error) {
    return emptyDashboardData(true, false, sanitizeError(error));
  }
}
