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
    featureStats: [],
    recentFeatures: [],
    recentFeatureBuckets: [],
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
      featureStats,
      recentFeatures,
      recentFeatureBuckets,
    ] = await Promise.all([
      query(`
        select collector_name, last_seen_at, current_market_id, status, message
        from collector_heartbeats
        order by last_seen_at desc
        limit 1
      `),
      query(`
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
                'open_price', ml.open_price,
                'close_price', ml.close_price,
                'return_pct', ml.return_pct,
                'direction', ml.direction,
                'sample_count', ml.sample_count,
                'quality', ml.quality
              )
              order by ml.source
            ) filter (where ml.source is not null),
            '[]'::json
          ) as labels
        from markets m
        left join market_labels ml on ml.market_id = m.id
        group by m.id
        order by m.start_time desc
        limit 16
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
        select
          mf.source,
          count(*)::int as feature_rows,
          round(avg(mf.agg_trade_count))::int as avg_agg_trades,
          round(avg(mf.book_sample_count))::int as avg_book_samples,
          avg(mf.total_volume_quote) as avg_total_volume_quote,
          avg(mf.taker_imbalance) as avg_taker_imbalance,
          avg(mf.avg_book_imbalance_5bps) as avg_book_imbalance_5bps
        from market_features mf
        join markets m on m.id = mf.market_id
        where m.start_time >= now() - interval '24 hours'
        group by mf.source
        order by mf.source
      `),
      query(`
        select
          mf.market_id,
          m.start_time,
          m.end_time,
          mf.source,
          mf.feature_quality,
          mf.total_volume_quote,
          mf.net_taker_quote,
          mf.taker_imbalance,
          mf.agg_trade_count,
          mf.book_sample_count,
          mf.avg_spread_bps,
          mf.avg_book_imbalance_5bps,
          mf.avg_bid_depth_5bps,
          mf.avg_ask_depth_5bps,
          ml.direction,
          ml.return_pct
        from market_features mf
        join markets m on m.id = mf.market_id
        left join market_labels ml
          on ml.market_id = mf.market_id
         and ml.source = mf.source
        order by m.start_time desc, mf.source
        limit 8
      `),
      query(`
        select
          market_id,
          source,
          symbol,
          bucket_start,
          bucket_end,
          bucket_seconds,
          bucket_quality,
          open_price,
          close_price,
          return_pct,
          direction,
          total_volume_quote,
          net_taker_quote,
          taker_imbalance,
          agg_trade_count,
          spread_bps,
          book_imbalance_5bps,
          bid_depth_5bps,
          ask_depth_5bps
        from market_feature_buckets
        order by bucket_start desc, source
        limit 12
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
      featureStats: featureStats.rows,
      recentFeatures: recentFeatures.rows,
      recentFeatureBuckets: recentFeatureBuckets.rows,
    };
  } catch (error) {
    return emptyDashboardData(true, false, sanitizeError(error));
  }
}
