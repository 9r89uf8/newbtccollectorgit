import { query } from "../lib/db.js";
import {
  FUTURES_MICROSTRUCTURE_SOURCE,
  LARGE_TRADE_QUOTE_THRESHOLD,
} from "./config.mjs";

const VALID_BUCKET_QUALITIES = new Set(["complete", "partial", "missing"]);

function normalizeBucketQuality(value) {
  return VALID_BUCKET_QUALITIES.has(value) ? value : "partial";
}

export async function writeMarketTradeFlow1s(market, { bucketQuality = "complete" } = {}) {
  const source = FUTURES_MICROSTRUCTURE_SOURCE;
  const normalizedQuality = normalizeBucketQuality(bucketQuality);

  const result = await query(
    `
      with second_slots as (
        select generate_series(
          $3::timestamptz,
          $4::timestamptz - interval '1 second',
          interval '1 second'
        ) as bucket_start
      ),
      prior_seed as (
        select coalesce(
          (
            select cvd_continuous_quote
            from market_trade_flow_1s
            where symbol = $1
              and source = $2
              and bucket_start < $3
            order by bucket_start desc
            limit 1
          ),
          0
        ) as cvd_seed
      ),
      base as (
        select
          $6 as market_id,
          $2 as source,
          $1 as symbol,
          slots.bucket_start,
          slots.bucket_start + interval '1 second' as bucket_end,
          1::numeric as bucket_seconds,
          mp.mid_price,
          coalesce(trades.taker_buy_quote, 0) as taker_buy_quote,
          coalesce(trades.taker_sell_quote, 0) as taker_sell_quote,
          coalesce(trades.large_buy_quote, 0) as large_buy_quote,
          coalesce(trades.large_sell_quote, 0) as large_sell_quote,
          coalesce(trades.large_trade_count, 0) as large_trade_count,
          trades.max_trade_quote,
          coalesce(trades.trade_count, 0) as trade_count
        from second_slots slots
        left join market_microprice_buckets mp
          on mp.market_id = $6
         and mp.bucket_start = slots.bucket_start
        left join lateral (
          select
            count(*)::int as trade_count,
            coalesce(sum(quote_notional) filter (where taker_side = 'buy'), 0) as taker_buy_quote,
            coalesce(sum(quote_notional) filter (where taker_side = 'sell'), 0) as taker_sell_quote,
            coalesce(sum(quote_notional) filter (where taker_side = 'buy' and quote_notional >= $5), 0) as large_buy_quote,
            coalesce(sum(quote_notional) filter (where taker_side = 'sell' and quote_notional >= $5), 0) as large_sell_quote,
            count(*) filter (where quote_notional >= $5)::int as large_trade_count,
            max(quote_notional) as max_trade_quote
          from agg_trades t
          where t.symbol = $1
            and t.source = $2
            and t.trade_time >= slots.bucket_start
            and t.trade_time < slots.bucket_start + interval '1 second'
        ) trades on true
      ),
      calculated as (
        select
          *,
          taker_buy_quote - taker_sell_quote as net_taker_quote,
          taker_buy_quote + taker_sell_quote as gross_taker_quote,
          (taker_buy_quote - taker_sell_quote) / nullif(taker_buy_quote + taker_sell_quote, 0) as taker_imbalance
        from base
      ),
      rolling as (
        select
          *,
          sum(net_taker_quote) over win_market as cvd_market_quote,
          (select cvd_seed from prior_seed) + sum(net_taker_quote) over win_market as cvd_continuous_quote,
          sum(net_taker_quote) over win5 as rolling_net_5s,
          sum(net_taker_quote) over win10 as rolling_net_10s,
          sum(net_taker_quote) over win30 as rolling_net_30s,
          sum(gross_taker_quote) over win5 as rolling_gross_5s,
          sum(gross_taker_quote) over win10 as rolling_gross_10s,
          sum(gross_taker_quote) over win30 as rolling_gross_30s
        from calculated
        window
          win_market as (order by bucket_start rows between unbounded preceding and current row),
          win5 as (order by bucket_start rows between 4 preceding and current row),
          win10 as (order by bucket_start rows between 9 preceding and current row),
          win30 as (order by bucket_start rows between 29 preceding and current row)
      ),
      lagged as (
        select
          *,
          lag(cvd_market_quote, 5) over (order by bucket_start) as cvd_market_quote_5s_ago,
          lag(cvd_market_quote, 10) over (order by bucket_start) as cvd_market_quote_10s_ago,
          lag(cvd_market_quote, 30) over (order by bucket_start) as cvd_market_quote_30s_ago,
          lag(mid_price, 5) over (order by bucket_start) as mid_price_5s_ago,
          lag(mid_price, 10) over (order by bucket_start) as mid_price_10s_ago,
          lag(mid_price, 30) over (order by bucket_start) as mid_price_30s_ago
        from rolling
      )
      insert into market_trade_flow_1s
        (
          market_id,
          source,
          symbol,
          bucket_start,
          bucket_end,
          bucket_seconds,
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
          large_trade_threshold,
          max_trade_quote,
          trade_count,
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
        mid_price,
        taker_buy_quote,
        taker_sell_quote,
        net_taker_quote,
        gross_taker_quote,
        taker_imbalance,
        cvd_market_quote,
        cvd_continuous_quote,
        cvd_market_quote - cvd_market_quote_5s_ago as cvd_change_5s,
        cvd_market_quote - cvd_market_quote_10s_ago as cvd_change_10s,
        cvd_market_quote - cvd_market_quote_30s_ago as cvd_change_30s,
        case
          when mid_price is not null and mid_price_5s_ago is not null and mid_price_5s_ago != 0
            then ((mid_price - mid_price_5s_ago) / mid_price_5s_ago) * 10000
          else null
        end as price_change_5s_bps,
        case
          when mid_price is not null and mid_price_10s_ago is not null and mid_price_10s_ago != 0
            then ((mid_price - mid_price_10s_ago) / mid_price_10s_ago) * 10000
          else null
        end as price_change_10s_bps,
        case
          when mid_price is not null and mid_price_30s_ago is not null and mid_price_30s_ago != 0
            then ((mid_price - mid_price_30s_ago) / mid_price_30s_ago) * 10000
          else null
        end as price_change_30s_bps,
        rolling_net_5s,
        rolling_net_10s,
        rolling_net_30s,
        rolling_gross_5s,
        rolling_gross_10s,
        rolling_gross_30s,
        rolling_net_5s / nullif(rolling_gross_5s, 0) as rolling_imbalance_5s,
        rolling_net_10s / nullif(rolling_gross_10s, 0) as rolling_imbalance_10s,
        rolling_net_30s / nullif(rolling_gross_30s, 0) as rolling_imbalance_30s,
        large_buy_quote,
        large_sell_quote,
        large_trade_count,
        $5 as large_trade_threshold,
        max_trade_quote,
        trade_count,
        $7 as bucket_quality,
        now()
      from lagged
      on conflict (market_id, source, bucket_start) do update set
        symbol = excluded.symbol,
        bucket_end = excluded.bucket_end,
        bucket_seconds = excluded.bucket_seconds,
        mid_price = excluded.mid_price,
        taker_buy_quote = excluded.taker_buy_quote,
        taker_sell_quote = excluded.taker_sell_quote,
        net_taker_quote = excluded.net_taker_quote,
        gross_taker_quote = excluded.gross_taker_quote,
        taker_imbalance = excluded.taker_imbalance,
        cvd_market_quote = excluded.cvd_market_quote,
        cvd_continuous_quote = excluded.cvd_continuous_quote,
        cvd_change_5s = excluded.cvd_change_5s,
        cvd_change_10s = excluded.cvd_change_10s,
        cvd_change_30s = excluded.cvd_change_30s,
        price_change_5s_bps = excluded.price_change_5s_bps,
        price_change_10s_bps = excluded.price_change_10s_bps,
        price_change_30s_bps = excluded.price_change_30s_bps,
        rolling_net_5s = excluded.rolling_net_5s,
        rolling_net_10s = excluded.rolling_net_10s,
        rolling_net_30s = excluded.rolling_net_30s,
        rolling_gross_5s = excluded.rolling_gross_5s,
        rolling_gross_10s = excluded.rolling_gross_10s,
        rolling_gross_30s = excluded.rolling_gross_30s,
        rolling_imbalance_5s = excluded.rolling_imbalance_5s,
        rolling_imbalance_10s = excluded.rolling_imbalance_10s,
        rolling_imbalance_30s = excluded.rolling_imbalance_30s,
        large_buy_quote = excluded.large_buy_quote,
        large_sell_quote = excluded.large_sell_quote,
        large_trade_count = excluded.large_trade_count,
        large_trade_threshold = excluded.large_trade_threshold,
        max_trade_quote = excluded.max_trade_quote,
        trade_count = excluded.trade_count,
        bucket_quality = excluded.bucket_quality,
        updated_at = now()
      returning bucket_start
    `,
    [
      market.symbol,
      source.source,
      market.start,
      market.end,
      LARGE_TRADE_QUOTE_THRESHOLD,
      market.id,
      normalizedQuality,
    ]
  );

  return {
    source: source.source,
    tradeFlowBucketCount: result.rowCount,
    bucketQuality: normalizedQuality,
  };
}