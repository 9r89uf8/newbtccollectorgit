import { hasDatabaseConfig, query } from "./db.js";

const TRANSITION_SECONDS = 60;

function sanitizeError(error) {
  if (!error) return "Unknown database error";
  return error.message || String(error);
}

function emptyMarketTransitionData(configured, ok, error) {
  return {
    configured,
    ok,
    error,
    currentMarket: null,
    previousMarket: null,
    windowStart: null,
    boundaryTime: null,
    windowEnd: null,
    buckets: [],
    tradeFlow1s: [],
    priceSeries: [],
    chainlinkPriceSeries: [],
    positionSeries: [],
    webSocketSummaries: [],
    micropriceBuckets: [],
    polymarketProbabilitySeries: [],
  };
}

function shiftSeconds(value, seconds) {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(date.getTime() + seconds * 1000);
}

function marketSelectSql(whereClause) {
  return `
    select
      m.id,
      m.symbol,
      m.start_time,
      m.end_time,
      m.status,
      pr.binance_futures_open_price,
      pr.binance_futures_close_price,
      pr.binance_futures_return_pct,
      pr.binance_futures_direction,
      pr.polymarket_open_price,
      pr.polymarket_close_price,
      pr.polymarket_return_pct,
      pr.polymarket_direction,
      pr.polymarket_winning_outcome,
      pr.polymarket_slug
    from markets m
    left join market_price_references pr on pr.market_id = m.id
    ${whereClause}
  `;
}

export async function getMarketTransitionData(marketId) {
  if (!hasDatabaseConfig()) {
    return emptyMarketTransitionData(false, false, "DATABASE_URL is not configured.");
  }

  if (!marketId) {
    return emptyMarketTransitionData(true, false, "Market id is required.");
  }

  try {
    const currentResult = await query(
      `${marketSelectSql("where m.id = $1")}
       limit 1`,
      [marketId]
    );

    const currentMarket = currentResult.rows[0] || null;
    if (!currentMarket) {
      return emptyMarketTransitionData(true, true, null);
    }

    const previousResult = await query(
      `${marketSelectSql(`
        where m.symbol = $1
          and m.end_time = $2
          and m.id <> $3
      `)}
       order by m.end_time desc
       limit 1`,
      [currentMarket.symbol, currentMarket.start_time, currentMarket.id]
    );

    const previousMarket = previousResult.rows[0] || null;
    const boundaryTime = currentMarket.start_time;
    const windowStart = shiftSeconds(boundaryTime, -TRANSITION_SECONDS);
    const windowEnd = shiftSeconds(boundaryTime, TRANSITION_SECONDS);
    const marketIds = [previousMarket?.id, currentMarket.id].filter(Boolean);

    const [
      buckets,
      tradeFlow1s,
      priceSeries,
      chainlinkPriceSeries,
      positionSeries,
      webSocketSummaries,
      micropriceBuckets,
      polymarketProbabilitySeries,
    ] = await Promise.all([
      query(
        `
          select
            b.market_id,
            b.source,
            b.symbol,
            b.bucket_start,
            b.bucket_end,
            b.bucket_seconds,
            b.bucket_quality,
            b.open_price,
            b.close_price,
            b.return_pct,
            b.direction,
            b.total_volume_quote,
            b.taker_buy_quote,
            b.taker_sell_quote,
            b.net_taker_quote,
            b.taker_imbalance,
            b.agg_trade_count,
            b.large_trade_count,
            b.max_trade_quote,
            b.best_bid_price,
            b.best_ask_price,
            b.mid_price,
            b.spread_bps,
            b.bid_depth_5bps,
            b.ask_depth_5bps,
            b.book_imbalance_5bps,
            b.bid_depth_10bps,
            b.ask_depth_10bps,
            b.book_imbalance_10bps,
            b.bid_depth_25bps,
            b.ask_depth_25bps,
            b.book_imbalance_25bps,
            cvd.delta_quote,
            cvd.cvd_market_quote,
            cvd.cvd_continuous_quote,
            cvd.cvd_change_5b,
            cvd.price_change_5b_bps,
            cvd.cvd_direction,
            cvd.price_direction,
            cvd.cvd_price_behavior,
            cvd.cvd_divergence_5b
          from market_feature_buckets b
          left join market_cvd_buckets cvd
            on cvd.market_id = b.market_id
           and cvd.source = b.source
           and cvd.bucket_start = b.bucket_start
          where b.market_id = any($1::text[])
            and b.bucket_start >= $2
            and b.bucket_start < $3
          order by b.bucket_start asc, b.market_id asc
        `,
        [marketIds, windowStart, windowEnd]
      ),
      query(
        `
          select
            market_id,
            bucket_start,
            bucket_end,
            bucket_seconds,
            bucket_quality,
            mid_price,
            taker_buy_quote,
            taker_sell_quote,
            net_taker_quote,
            gross_taker_quote,
            taker_imbalance,
            cvd_market_quote,
            cvd_continuous_quote,
            cvd_change_5s,
            cvd_change_10s,
            cvd_change_30s,
            price_change_5s_bps,
            price_change_10s_bps,
            price_change_30s_bps,
            rolling_net_5s,
            rolling_net_10s,
            rolling_net_30s,
            rolling_gross_5s,
            rolling_gross_10s,
            rolling_gross_30s,
            rolling_imbalance_5s,
            rolling_imbalance_10s,
            rolling_imbalance_30s,
            large_buy_quote,
            large_sell_quote,
            large_trade_count,
            max_trade_quote,
            trade_count
          from market_trade_flow_1s
          where market_id = any($1::text[])
            and bucket_start >= $2
            and bucket_start < $3
          order by bucket_start asc, market_id asc
        `,
        [marketIds, windowStart, windowEnd]
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
        [currentMarket.symbol, windowStart, windowEnd]
      ),
      query(
        `
          select
            market_id,
            scheduled_at,
            collected_at,
            source,
            sample_type,
            price,
            bid,
            ask,
            topic,
            rtds_symbol,
            valid_from_timestamp,
            observations_timestamp,
            price_timestamp,
            server_timestamp,
            request_latency_ms,
            report_latency_ms,
            tick_age_ms,
            quality,
            decode_status
          from chainlink_btc_price_samples
          where market_id = any($1::text[])
            and scheduled_at >= $2
            and scheduled_at <= $3
          order by scheduled_at asc, market_id asc
        `,
        [marketIds, windowStart, windowEnd]
      ),
      query(
        `
          select
            scheduled_at,
            source,
            sample_type,
            mark_price,
            index_price,
            premium_bps,
            funding_rate,
            open_interest_base,
            open_interest_quote
          from derivative_position_samples
          where symbol = $1
            and source = 'binance_futures'
            and scheduled_at >= $2
            and scheduled_at <= $3
          order by scheduled_at asc
        `,
        [currentMarket.symbol, windowStart, windowEnd]
      ),
      query(
        `
          select
            bucket_start,
            bucket_end,
            summary_quality,
            event_count,
            book_ticker_update_count,
            bid_price_move_count,
            ask_price_move_count,
            mid_price_move_count,
            best_bid_price_close,
            best_ask_price_close,
            mid_price_close,
            mid_return_bps,
            spread_bps_avg,
            spread_bps_max,
            microprice_bps_from_mid_close,
            liquidation_count,
            liquidation_buy_quote,
            liquidation_sell_quote,
            liquidation_net_quote,
            liquidation_max_quote,
            avg_event_lag_ms,
            max_event_lag_ms
          from futures_ws_1s_summaries
          where symbol = $1
            and source = 'binance_futures_ws'
            and bucket_start >= $2
            and bucket_start < $3
          order by bucket_start asc
        `,
        [currentMarket.symbol, windowStart, windowEnd]
      ),
      query(
        `
          select
            market_id,
            bucket_start,
            bucket_end,
            bucket_quality,
            source_summary_quality,
            book_ticker_update_count,
            seconds_since_book_update,
            mid_price,
            spread_bps_close,
            spread_bps_avg,
            spread_bps_max,
            microprice,
            microprice_bps_from_mid,
            microprice_lean,
            microprice_delta,
            lean_delta_1s,
            ewma_lean_3s,
            avg_lean_5s,
            microprice_pressure_market,
            microprice_pressure_continuous,
            avg_lean_10s,
            avg_lean_30s,
            up_lean_share_10s,
            down_lean_share_10s,
            up_lean_share_30s,
            down_lean_share_30s,
            valid_sample_count_10s,
            valid_sample_count_30s,
            spread_stable_10s,
            spread_stable_30s,
            mid_change_10s_bps,
            mid_change_30s_bps,
            price_stalled_10s,
            price_stalled_30s,
            lean_direction,
            persistence_signal,
            flip_signal,
            microprice_behavior
          from market_microprice_buckets
          where market_id = any($1::text[])
            and bucket_start >= $2
            and bucket_start < $3
          order by bucket_start asc, market_id asc
        `,
        [marketIds, windowStart, windowEnd]
      ),
      query(
        `
          select
            market_id,
            scheduled_at,
            sample_type,
            up_probability,
            down_probability,
            up_probability_normalized,
            down_probability_normalized,
            probability_sum,
            quality
          from polymarket_probability_samples
          where market_id = any($1::text[])
            and scheduled_at >= $2
            and scheduled_at < $3
          order by scheduled_at asc, market_id asc
        `,
        [marketIds, windowStart, windowEnd]
      ),
    ]);

    return {
      configured: true,
      ok: true,
      error: null,
      currentMarket,
      previousMarket,
      windowStart,
      boundaryTime,
      windowEnd,
      buckets: buckets.rows,
      tradeFlow1s: tradeFlow1s.rows,
      priceSeries: priceSeries.rows,
      chainlinkPriceSeries: chainlinkPriceSeries.rows,
      positionSeries: positionSeries.rows,
      webSocketSummaries: webSocketSummaries.rows,
      micropriceBuckets: micropriceBuckets.rows,
      polymarketProbabilitySeries: polymarketProbabilitySeries.rows,
    };
  } catch (error) {
    return emptyMarketTransitionData(true, false, sanitizeError(error));
  }
}
