import { query } from "../lib/db.js";
import {
  FUTURES_MICROSTRUCTURE_SOURCE,
  LARGE_TRADE_QUOTE_THRESHOLD,
} from "./config.mjs";

export async function writeMarketFeatureBuckets(market) {
  const source = FUTURES_MICROSTRUCTURE_SOURCE;

  const result = await query(
    `
      with book_buckets as (
        select
          b.*,
          lead(b.scheduled_at) over (order by b.scheduled_at) as next_scheduled_at
        from book_samples b
        where b.symbol = $1
          and b.source = $2
          and b.scheduled_at >= $3
          and b.scheduled_at < $4
      ),
      buckets as (
        select
          b.*,
          coalesce(b.next_scheduled_at, $4) as bucket_end
        from book_buckets b
      ),
      price_at as (
        select distinct on (scheduled_at)
          scheduled_at,
          price
        from price_samples
        where symbol = $1
          and source = $2
          and scheduled_at >= $3
          and scheduled_at <= $4
        order by
          scheduled_at,
          case sample_type
            when 'close' then 0
            when 'normal' then 1
            when 'final_ramp' then 2
            else 3
          end,
          collected_at desc
      ),
      bucket_rows as (
        select
          b.scheduled_at as bucket_start,
          b.bucket_end,
          extract(epoch from (b.bucket_end - b.scheduled_at))::numeric as bucket_seconds,
          open_price.price as open_price,
          close_price.price as close_price,
          coalesce(trades.agg_trade_count, 0) as agg_trade_count,
          coalesce(trades.total_volume_quote, 0) as total_volume_quote,
          coalesce(trades.taker_buy_quote, 0) as taker_buy_quote,
          coalesce(trades.taker_sell_quote, 0) as taker_sell_quote,
          coalesce(trades.large_trade_count, 0) as large_trade_count,
          trades.max_trade_quote,
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
          b.book_imbalance_25bps
        from buckets b
        left join lateral (
          select
            count(*)::int as agg_trade_count,
            coalesce(sum(quote_notional), 0) as total_volume_quote,
            coalesce(sum(quote_notional) filter (where taker_side = 'buy'), 0) as taker_buy_quote,
            coalesce(sum(quote_notional) filter (where taker_side = 'sell'), 0) as taker_sell_quote,
            count(*) filter (where quote_notional >= $5)::int as large_trade_count,
            max(quote_notional) as max_trade_quote
          from agg_trades t
          where t.symbol = $1
            and t.source = $2
            and t.trade_time >= b.scheduled_at
            and t.trade_time < b.bucket_end
        ) trades on true
        left join price_at open_price
          on open_price.scheduled_at = b.scheduled_at
        left join price_at close_price
          on close_price.scheduled_at = b.bucket_end
      )
      insert into market_feature_buckets
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
          direction,
          total_volume_quote,
          taker_buy_quote,
          taker_sell_quote,
          net_taker_quote,
          taker_imbalance,
          agg_trade_count,
          large_trade_count,
          large_trade_threshold,
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
          book_imbalance_25bps,
          bucket_quality,
          updated_at
        )
      select
        $6,
        $2,
        $1,
        bucket_start,
        bucket_end,
        bucket_seconds,
        open_price,
        close_price,
        case
          when open_price is not null and close_price is not null and open_price > 0
            then ((close_price - open_price) / open_price) * 100
          else null
        end as return_pct,
        case
          when open_price is null or close_price is null then null
          when close_price > open_price then 'up'
          when close_price < open_price then 'down'
          else 'flat'
        end as direction,
        total_volume_quote,
        taker_buy_quote,
        taker_sell_quote,
        taker_buy_quote - taker_sell_quote,
        (taker_buy_quote - taker_sell_quote) / nullif(taker_buy_quote + taker_sell_quote, 0),
        agg_trade_count,
        large_trade_count,
        $5,
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
        book_imbalance_25bps,
        case
          when open_price is not null and close_price is not null then 'complete'
          else 'partial'
        end as bucket_quality,
        now()
      from bucket_rows
      on conflict (market_id, source, bucket_start) do update set
        symbol = excluded.symbol,
        bucket_end = excluded.bucket_end,
        bucket_seconds = excluded.bucket_seconds,
        open_price = excluded.open_price,
        close_price = excluded.close_price,
        return_pct = excluded.return_pct,
        direction = excluded.direction,
        total_volume_quote = excluded.total_volume_quote,
        taker_buy_quote = excluded.taker_buy_quote,
        taker_sell_quote = excluded.taker_sell_quote,
        net_taker_quote = excluded.net_taker_quote,
        taker_imbalance = excluded.taker_imbalance,
        agg_trade_count = excluded.agg_trade_count,
        large_trade_count = excluded.large_trade_count,
        large_trade_threshold = excluded.large_trade_threshold,
        max_trade_quote = excluded.max_trade_quote,
        best_bid_price = excluded.best_bid_price,
        best_ask_price = excluded.best_ask_price,
        mid_price = excluded.mid_price,
        spread_bps = excluded.spread_bps,
        bid_depth_5bps = excluded.bid_depth_5bps,
        ask_depth_5bps = excluded.ask_depth_5bps,
        book_imbalance_5bps = excluded.book_imbalance_5bps,
        bid_depth_10bps = excluded.bid_depth_10bps,
        ask_depth_10bps = excluded.ask_depth_10bps,
        book_imbalance_10bps = excluded.book_imbalance_10bps,
        bid_depth_25bps = excluded.bid_depth_25bps,
        ask_depth_25bps = excluded.ask_depth_25bps,
        book_imbalance_25bps = excluded.book_imbalance_25bps,
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
    ]
  );

  return {
    source: source.source,
    bucketCount: result.rowCount,
  };
}
