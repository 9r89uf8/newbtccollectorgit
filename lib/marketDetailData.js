import { hasDatabaseConfig, query } from "./db.js";

function sanitizeError(error) {
  if (!error) return "Unknown database error";
  return error.message || String(error);
}

function emptyMarketDetailData(configured, ok, error) {
  return {
    configured,
    ok,
    error,
    market: null,
    labels: [],
    features: [],
    positionFeatures: [],
    behaviorLabels: [],
    classifications: [],
    buckets: [],
    priceSeries: [],
    sampleStats: [],
    topTrades: [],
    errors: [],
  };
}

export async function getMarketDetailData(marketId) {
  if (!hasDatabaseConfig()) {
    return emptyMarketDetailData(false, false, "DATABASE_URL is not configured.");
  }

  if (!marketId) {
    return emptyMarketDetailData(true, false, "Market id is required.");
  }

  try {
    const marketResult = await query(
      `
        select id, symbol, start_time, end_time, status, created_at, closed_at
        from markets
        where id = $1
        limit 1
      `,
      [marketId]
    );

    const market = marketResult.rows[0] || null;
    if (!market) {
      return emptyMarketDetailData(true, true, null);
    }

    const [
      labels,
      features,
      positionFeatures,
      behaviorLabels,
      classifications,
      buckets,
      priceSeries,
      sampleStats,
      topTrades,
      errors,
    ] = await Promise.all([
      query(
        `
          select
            source,
            open_price,
            close_price,
            return_pct,
            direction,
            sample_count,
            quality,
            created_at
          from market_labels
          where market_id = $1
          order by source
        `,
        [marketId]
      ),
      query(
        `
          select *
          from market_features
          where market_id = $1
          order by source
        `,
        [marketId]
      ),
      query(
        `
          select *
          from market_position_features
          where market_id = $1
          order by source
        `,
        [marketId]
      ),
      query(
        `
          select *
          from market_behavior_labels
          where market_id = $1
          order by source
        `,
        [marketId]
      ),
      query(
        `
          select *
          from market_classifications
          where market_id = $1
          order by source
        `,
        [marketId]
      ),
      query(
        `
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
            taker_buy_quote,
            taker_sell_quote,
            net_taker_quote,
            taker_imbalance,
            agg_trade_count,
            large_trade_count,
            max_trade_quote,
            best_bid_price,
            best_ask_price,
            mid_price,
            spread_bps,
            bid_depth_5bps,
            ask_depth_5bps,
            book_imbalance_5bps,
            bid_depth_10bps,
            ask_depth_10bps,
            book_imbalance_10bps,
            bid_depth_25bps,
            ask_depth_25bps,
            book_imbalance_25bps
          from market_feature_buckets
          where market_id = $1
          order by bucket_start asc
        `,
        [marketId]
      ),
      query(
        `
          select distinct on (scheduled_at)
            scheduled_at,
            collected_at,
            source,
            sample_type,
            price
          from price_samples
          where symbol = $1
            and source = 'binance_futures'
            and scheduled_at >= $2
            and scheduled_at <= $3
          order by
            scheduled_at,
            case sample_type
              when 'close' then 0
              when 'normal' then 1
              when 'final_ramp' then 2
              else 3
            end,
            collected_at desc
        `,
        [market.symbol, market.start_time, market.end_time]
      ),
      query(
        `
          select
            source,
            count(*)::int as sample_count,
            min(scheduled_at) as first_sample_at,
            max(scheduled_at) as last_sample_at,
            min(price) as min_price,
            max(price) as max_price,
            round(avg(latency_ms))::int as avg_latency_ms
          from price_samples
          where symbol = $1
            and scheduled_at >= $2
            and scheduled_at <= $3
          group by source
          order by source
        `,
        [market.symbol, market.start_time, market.end_time]
      ),
      query(
        `
          select
            agg_trade_id,
            trade_time,
            price,
            quantity,
            quote_notional,
            taker_side,
            buyer_is_maker
          from agg_trades
          where symbol = $1
            and source = 'binance_futures'
            and trade_time >= $2
            and trade_time < $3
          order by quote_notional desc
          limit 12
        `,
        [market.symbol, market.start_time, market.end_time]
      ),
      query(
        `
          select time, source, error_type, message, retry_count
          from collection_errors
          where market_id = $1
          order by time desc
          limit 12
        `,
        [marketId]
      ),
    ]);

    return {
      configured: true,
      ok: true,
      error: null,
      market,
      labels: labels.rows,
      features: features.rows,
      positionFeatures: positionFeatures.rows,
      behaviorLabels: behaviorLabels.rows,
      classifications: classifications.rows,
      buckets: buckets.rows,
      priceSeries: priceSeries.rows,
      sampleStats: sampleStats.rows,
      topTrades: topTrades.rows,
      errors: errors.rows,
    };
  } catch (error) {
    return emptyMarketDetailData(true, false, sanitizeError(error));
  }
}
