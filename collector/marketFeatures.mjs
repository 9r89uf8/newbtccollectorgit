import { query } from "../lib/db.js";
import {
  EXPECTED_BOOK_SAMPLES_PER_MARKET,
  FUTURES_MICROSTRUCTURE_SOURCE,
  LARGE_TRADE_QUOTE_THRESHOLD,
} from "./config.mjs";

export async function writeMarketFeatures(market) {
  const source = FUTURES_MICROSTRUCTURE_SOURCE;

  const result = await query(
    `
      with trade_stats as (
        select
          count(*)::int as agg_trade_count,
          coalesce(sum(quote_notional), 0) as total_volume_quote,
          coalesce(sum(quote_notional) filter (where taker_side = 'buy'), 0) as taker_buy_quote,
          coalesce(sum(quote_notional) filter (where taker_side = 'sell'), 0) as taker_sell_quote,
          count(*) filter (where quote_notional >= $6)::int as large_trade_count,
          max(quote_notional) as max_trade_quote
        from agg_trades
        where symbol = $1
          and source = $2
          and trade_time >= $3
          and trade_time < $4
      ),
      book_stats as (
        select
          count(*)::int as book_sample_count,
          avg(spread_bps) as avg_spread_bps,
          max(spread_bps) as max_spread_bps,
          avg(book_imbalance_5bps) as avg_book_imbalance_5bps,
          min(book_imbalance_5bps) as min_book_imbalance_5bps,
          max(book_imbalance_5bps) as max_book_imbalance_5bps,
          avg(bid_depth_5bps) as avg_bid_depth_5bps,
          avg(ask_depth_5bps) as avg_ask_depth_5bps,
          min(bid_depth_5bps) as min_bid_depth_5bps,
          min(ask_depth_5bps) as min_ask_depth_5bps,
          avg(ask_depth_5bps / nullif(bid_depth_5bps, 0)) as avg_ask_bid_depth_ratio
        from book_samples
        where symbol = $1
          and source = $2
          and scheduled_at >= $3
          and scheduled_at < $4
      ),
      features as (
        select
          trade_stats.*,
          book_stats.*,
          (trade_stats.taker_buy_quote - trade_stats.taker_sell_quote) as net_taker_quote,
          (
            (trade_stats.taker_buy_quote - trade_stats.taker_sell_quote)
            / nullif(trade_stats.taker_buy_quote + trade_stats.taker_sell_quote, 0)
          ) as taker_imbalance,
          case
            when trade_stats.agg_trade_count = 0 and book_stats.book_sample_count = 0 then 'missing'
            when trade_stats.agg_trade_count > 0
              and book_stats.book_sample_count >= $5 then 'complete'
            else 'partial'
          end as feature_quality
        from trade_stats, book_stats
      )
      insert into market_features
        (
          market_id,
          source,
          symbol,
          total_volume_quote,
          taker_buy_quote,
          taker_sell_quote,
          net_taker_quote,
          taker_imbalance,
          agg_trade_count,
          large_trade_count,
          large_trade_threshold,
          max_trade_quote,
          book_sample_count,
          avg_spread_bps,
          max_spread_bps,
          avg_book_imbalance_5bps,
          min_book_imbalance_5bps,
          max_book_imbalance_5bps,
          avg_bid_depth_5bps,
          avg_ask_depth_5bps,
          min_bid_depth_5bps,
          min_ask_depth_5bps,
          avg_ask_bid_depth_ratio,
          feature_quality,
          updated_at
        )
      select
        $7,
        $2,
        $1,
        total_volume_quote,
        taker_buy_quote,
        taker_sell_quote,
        net_taker_quote,
        taker_imbalance,
        agg_trade_count,
        large_trade_count,
        $6,
        max_trade_quote,
        book_sample_count,
        avg_spread_bps,
        max_spread_bps,
        avg_book_imbalance_5bps,
        min_book_imbalance_5bps,
        max_book_imbalance_5bps,
        avg_bid_depth_5bps,
        avg_ask_depth_5bps,
        min_bid_depth_5bps,
        min_ask_depth_5bps,
        avg_ask_bid_depth_ratio,
        feature_quality,
        now()
      from features
      on conflict (market_id, source) do update set
        symbol = excluded.symbol,
        total_volume_quote = excluded.total_volume_quote,
        taker_buy_quote = excluded.taker_buy_quote,
        taker_sell_quote = excluded.taker_sell_quote,
        net_taker_quote = excluded.net_taker_quote,
        taker_imbalance = excluded.taker_imbalance,
        agg_trade_count = excluded.agg_trade_count,
        large_trade_count = excluded.large_trade_count,
        large_trade_threshold = excluded.large_trade_threshold,
        max_trade_quote = excluded.max_trade_quote,
        book_sample_count = excluded.book_sample_count,
        avg_spread_bps = excluded.avg_spread_bps,
        max_spread_bps = excluded.max_spread_bps,
        avg_book_imbalance_5bps = excluded.avg_book_imbalance_5bps,
        min_book_imbalance_5bps = excluded.min_book_imbalance_5bps,
        max_book_imbalance_5bps = excluded.max_book_imbalance_5bps,
        avg_bid_depth_5bps = excluded.avg_bid_depth_5bps,
        avg_ask_depth_5bps = excluded.avg_ask_depth_5bps,
        min_bid_depth_5bps = excluded.min_bid_depth_5bps,
        min_ask_depth_5bps = excluded.min_ask_depth_5bps,
        avg_ask_bid_depth_ratio = excluded.avg_ask_bid_depth_ratio,
        feature_quality = excluded.feature_quality,
        updated_at = now()
      returning *
    `,
    [
      market.symbol,
      source.source,
      market.start,
      market.end,
      EXPECTED_BOOK_SAMPLES_PER_MARKET,
      LARGE_TRADE_QUOTE_THRESHOLD,
      market.id,
    ]
  );

  return result.rows[0] || null;
}
