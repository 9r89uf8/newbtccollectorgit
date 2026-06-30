import { query } from "../lib/db.js";
import { FUTURES_MICROSTRUCTURE_SOURCE } from "./config.mjs";

export async function writeMarketCvdBuckets(market) {
  const source = FUTURES_MICROSTRUCTURE_SOURCE;

  const result = await query(
    `
      with prior_seed as (
        select coalesce(sum(net_taker_quote), 0) as cvd_seed
        from market_feature_buckets
        where symbol = $1
          and source = $2
          and bucket_start < $3
      ),
      bucket_delta as (
        select
          b.market_id,
          b.source,
          b.symbol,
          b.bucket_start,
          b.bucket_end,
          b.bucket_seconds,
          b.open_price,
          b.close_price,
          b.return_pct,
          case
            when b.open_price is not null
              and b.open_price != 0
              and b.close_price is not null
              then ((b.close_price - b.open_price) / b.open_price) * 10000
            else null
          end as return_bps,
          b.taker_buy_quote,
          b.taker_sell_quote,
          b.net_taker_quote as delta_quote,
          b.bucket_quality
        from market_feature_buckets b
        where b.symbol = $1
          and b.source = $2
          and b.market_id = $4
      ),
      bucket_cvd as (
        select
          *,
          sum(delta_quote) over (
            partition by market_id, source
            order by bucket_start
            rows between unbounded preceding and current row
          ) as cvd_market_quote,
          (select cvd_seed from prior_seed)
            + sum(delta_quote) over (
                order by bucket_start
                rows between unbounded preceding and current row
              ) as cvd_continuous_quote
        from bucket_delta
      ),
      bucket_lagged as (
        select
          *,
          lag(cvd_market_quote, 5) over (
            partition by market_id, source
            order by bucket_start
          ) as cvd_market_quote_5b_ago,
          lag(close_price, 5) over (
            partition by market_id, source
            order by bucket_start
          ) as close_price_5b_ago
        from bucket_cvd
      ),
      bucket_signals as (
        select
          *,
          cvd_market_quote - cvd_market_quote_5b_ago as cvd_change_5b,
          case
            when close_price_5b_ago is not null
              and close_price_5b_ago != 0
              and close_price is not null
              then ((close_price - close_price_5b_ago) / close_price_5b_ago) * 10000
            else null
          end as price_change_5b_bps
        from bucket_lagged
      )
      insert into market_cvd_buckets
        (
          market_id,
          source,
          symbol,
          bucket_start,
          bucket_end,
          bucket_seconds,
          open_price,
          close_price,
          return_pct,
          return_bps,
          taker_buy_quote,
          taker_sell_quote,
          delta_quote,
          cvd_market_quote,
          cvd_continuous_quote,
          cvd_change_5b,
          price_change_5b_bps,
          cvd_direction,
          price_direction,
          cvd_price_behavior,
          cvd_divergence_5b,
          bucket_quality,
          updated_at
        )
      select
        market_id,
        source,
        symbol,
        bucket_start,
        bucket_end,
        bucket_seconds,
        open_price,
        close_price,
        return_pct,
        return_bps,
        taker_buy_quote,
        taker_sell_quote,
        delta_quote,
        cvd_market_quote,
        cvd_continuous_quote,
        cvd_change_5b,
        price_change_5b_bps,
        case
          when delta_quote > 0 then 'cvd_up'
          when delta_quote < 0 then 'cvd_down'
          else 'cvd_flat'
        end as cvd_direction,
        case
          when return_bps > 1.0 then 'price_up'
          when return_bps < -1.0 then 'price_down'
          else 'price_flat'
        end as price_direction,
        case
          when delta_quote > 0 and return_bps > 1.0
            then 'buyers_in_control'
          when delta_quote > 0 and abs(return_bps) <= 1.0
            then 'buy_pressure_absorbed_by_sellers'
          when delta_quote < 0 and abs(return_bps) <= 1.0
            then 'sell_pressure_absorbed_by_buyers'
          when delta_quote < 0 and return_bps < -1.0
            then 'sellers_in_control'
          when delta_quote > 0 and return_bps < -1.0
            then 'aggressive_buying_failed'
          when delta_quote < 0 and return_bps > 1.0
            then 'aggressive_selling_failed'
          else 'neutral'
        end as cvd_price_behavior,
        case
          when cvd_change_5b > 0 and price_change_5b_bps > 1.0
            then 'buyers_in_control'
          when cvd_change_5b > 0 and abs(price_change_5b_bps) <= 1.0
            then 'sellers_absorbing_buy_pressure'
          when cvd_change_5b < 0 and abs(price_change_5b_bps) <= 1.0
            then 'buyers_absorbing_sell_pressure'
          when cvd_change_5b < 0 and price_change_5b_bps < -1.0
            then 'sellers_in_control'
          when cvd_change_5b > 0 and price_change_5b_bps < -1.0
            then 'buying_failed_bearish'
          when cvd_change_5b < 0 and price_change_5b_bps > 1.0
            then 'selling_failed_bullish'
          else 'neutral'
        end as cvd_divergence_5b,
        bucket_quality,
        now()
      from bucket_signals
      on conflict (market_id, source, bucket_start) do update set
        symbol = excluded.symbol,
        bucket_end = excluded.bucket_end,
        bucket_seconds = excluded.bucket_seconds,
        open_price = excluded.open_price,
        close_price = excluded.close_price,
        return_pct = excluded.return_pct,
        return_bps = excluded.return_bps,
        taker_buy_quote = excluded.taker_buy_quote,
        taker_sell_quote = excluded.taker_sell_quote,
        delta_quote = excluded.delta_quote,
        cvd_market_quote = excluded.cvd_market_quote,
        cvd_continuous_quote = excluded.cvd_continuous_quote,
        cvd_change_5b = excluded.cvd_change_5b,
        price_change_5b_bps = excluded.price_change_5b_bps,
        cvd_direction = excluded.cvd_direction,
        price_direction = excluded.price_direction,
        cvd_price_behavior = excluded.cvd_price_behavior,
        cvd_divergence_5b = excluded.cvd_divergence_5b,
        bucket_quality = excluded.bucket_quality,
        updated_at = now()
      returning bucket_start
    `,
    [market.symbol, source.source, market.start, market.id]
  );

  return {
    source: source.source,
    cvdBucketCount: result.rowCount,
  };
}