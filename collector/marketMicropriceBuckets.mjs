import { query } from "../lib/db.js";
import { FUTURES_WEBSOCKET_SOURCE } from "./config.mjs";

const FEATURE_VERSION = "microprice_v2";
const STALE_BOOK_SECONDS = 5;
const LEAN_THRESHOLD = 0.20;
const MIN_VALID_10S = 8;
const MIN_VALID_30S = 24;

function rowToMarket(row) {
  return {
    id: row.id,
    symbol: row.symbol,
    start: new Date(row.start_time),
    end: new Date(row.end_time),
    startMs: new Date(row.start_time).getTime(),
    endMs: new Date(row.end_time).getTime(),
  };
}

export async function writeMarketMicropriceBuckets(market) {
  const source = FUTURES_WEBSOCKET_SOURCE;

  const result = await query(
    `
      with second_slots as (
        select generate_series(
          $3::timestamptz,
          $4::timestamptz - interval '1 second',
          interval '1 second'
        ) as bucket_start
      ),
      ws_rows as (
        select *
        from futures_ws_1s_summaries
        where symbol = $1
          and source = $2
          and bucket_start >= $3::timestamptz - interval '20 seconds'
          and bucket_start < $4
      ),
      base as (
        select
          $5 as market_id,
          $2 as source,
          $1 as symbol,
          slots.bucket_start,
          slots.bucket_start + interval '1 second' as bucket_end,
          1::numeric as bucket_seconds,
          direct.summary_quality as source_summary_quality,
          coalesce(direct.book_ticker_update_count, 0) as book_ticker_update_count,
          case
            when last_book.bucket_start is null then null
            else extract(epoch from (slots.bucket_start - last_book.bucket_start))::numeric
          end as seconds_since_book_update,
          last_book.best_bid_price_close as best_bid_price,
          last_book.best_bid_qty_close as best_bid_qty,
          last_book.best_ask_price_close as best_ask_price,
          last_book.best_ask_qty_close as best_ask_qty,
          last_book.mid_price_close as mid_price,
          last_book.spread_bps_close,
          last_book.spread_bps_avg,
          last_book.spread_bps_max,
          last_book.microprice_close as microprice,
          coalesce(
            last_book.microprice_bps_from_mid_close,
            case
              when last_book.microprice_close is not null
                and last_book.mid_price_close is not null
                and last_book.mid_price_close > 0
                then ((last_book.microprice_close - last_book.mid_price_close) / last_book.mid_price_close) * 10000
              else null
            end
          ) as microprice_bps_from_mid
        from second_slots slots
        left join ws_rows direct
          on direct.bucket_start = slots.bucket_start
        left join lateral (
          select prior.*
          from ws_rows prior
          where prior.bucket_start <= slots.bucket_start
            and prior.book_ticker_update_count > 0
            and prior.mid_price_close is not null
            and prior.microprice_close is not null
          order by prior.bucket_start desc
          limit 1
        ) last_book on true
      ),
      lean_calc as (
        select
          *,
          case
            when spread_bps_close is not null
              and spread_bps_close > 0
              and microprice_bps_from_mid is not null
              then 2.0 * microprice_bps_from_mid / spread_bps_close
            else null
          end as microprice_lean
        from base
      ),
      quality_calc as (
        select
          *,
          case
            when microprice_lean is null then 'missing'
            when seconds_since_book_update is null then 'missing'
            when seconds_since_book_update > $6 then 'stale'
            when book_ticker_update_count > 0 then 'complete'
            else 'partial'
          end as bucket_quality
        from lean_calc
      ),
      delta_calc as (
        select
          *,
          case
            when bucket_quality in ('complete', 'partial')
              then microprice_lean * bucket_seconds
            else 0
          end as microprice_delta
        from quality_calc
      ),
      prior_seed as (
        select coalesce(sum(microprice_delta), 0) as pressure_seed
        from market_microprice_buckets
        where symbol = $1
          and source = $2
          and bucket_start < $3
      ),
      cumulative as (
        select
          *,
          sum(microprice_delta) over (
            partition by market_id, source
            order by bucket_start
            rows between unbounded preceding and current row
          ) as microprice_pressure_market,
          (select pressure_seed from prior_seed)
            + sum(microprice_delta) over (
                order by bucket_start
                rows between unbounded preceding and current row
              ) as microprice_pressure_continuous
        from delta_calc
      ),
      lagged as (
        select
          *,
          case when bucket_quality in ('complete', 'partial') then microprice_lean end as valid_microprice_lean,
          lag(mid_price, 10) over (
            partition by source, symbol
            order by bucket_start
          ) as mid_price_10s_ago,
          lag(mid_price, 30) over (
            partition by source, symbol
            order by bucket_start
          ) as mid_price_30s_ago,
          lag(case when bucket_quality in ('complete', 'partial') then microprice_lean end, 1) over (
            partition by source, symbol
            order by bucket_start
          ) as prior_valid_lean,
          lag(case when bucket_quality in ('complete', 'partial') then microprice_lean end, 2) over (
            partition by source, symbol
            order by bucket_start
          ) as prior2_valid_lean
        from cumulative
      ),
      stats as (
        select
          *,
          case
            when valid_microprice_lean is not null
              and prior_valid_lean is not null
              then valid_microprice_lean - prior_valid_lean
            else null
          end as lean_delta_1s,
          case
            when valid_microprice_lean is not null then (
              (valid_microprice_lean * 0.5000)
                + coalesce(prior_valid_lean * 0.2500, 0)
                + coalesce(prior2_valid_lean * 0.1250, 0)
            ) / nullif(
              0.5000
                + case when prior_valid_lean is not null then 0.2500 else 0 end
                + case when prior2_valid_lean is not null then 0.1250 else 0 end,
              0
            )
            else null
          end as ewma_lean_3s,
          avg(microprice_lean) filter (where bucket_quality in ('complete', 'partial')) over win5 as avg_lean_5s,
          avg(microprice_lean) filter (where bucket_quality in ('complete', 'partial')) over win10 as avg_lean_10s,
          avg(microprice_lean) filter (where bucket_quality in ('complete', 'partial')) over win30 as avg_lean_30s,
          count(*) filter (where bucket_quality in ('complete', 'partial') and microprice_lean is not null) over win10 as valid_sample_count_10s,
          count(*) filter (where bucket_quality in ('complete', 'partial') and microprice_lean is not null) over win30 as valid_sample_count_30s,
          (
            count(*) filter (
              where bucket_quality in ('complete', 'partial')
                and microprice_lean >= $7
            ) over win10
          )::numeric / nullif(
            count(*) filter (where bucket_quality in ('complete', 'partial') and microprice_lean is not null) over win10,
            0
          ) as up_lean_share_10s,
          (
            count(*) filter (
              where bucket_quality in ('complete', 'partial')
                and microprice_lean <= -$7
            ) over win10
          )::numeric / nullif(
            count(*) filter (where bucket_quality in ('complete', 'partial') and microprice_lean is not null) over win10,
            0
          ) as down_lean_share_10s,
          (
            count(*) filter (
              where bucket_quality in ('complete', 'partial')
                and microprice_lean >= $7
            ) over win30
          )::numeric / nullif(
            count(*) filter (where bucket_quality in ('complete', 'partial') and microprice_lean is not null) over win30,
            0
          ) as up_lean_share_30s,
          (
            count(*) filter (
              where bucket_quality in ('complete', 'partial')
                and microprice_lean <= -$7
            ) over win30
          )::numeric / nullif(
            count(*) filter (where bucket_quality in ('complete', 'partial') and microprice_lean is not null) over win30,
            0
          ) as down_lean_share_30s,
          avg(spread_bps_avg) filter (where bucket_quality in ('complete', 'partial') and spread_bps_avg is not null) over win10 as spread_avg_10s,
          max(spread_bps_max) filter (where bucket_quality in ('complete', 'partial') and spread_bps_max is not null) over win10 as spread_max_10s,
          avg(spread_bps_avg) filter (where bucket_quality in ('complete', 'partial') and spread_bps_avg is not null) over win30 as spread_avg_30s,
          max(spread_bps_max) filter (where bucket_quality in ('complete', 'partial') and spread_bps_max is not null) over win30 as spread_max_30s
        from lagged
        window
          win5 as (
            partition by source, symbol
            order by bucket_start
            rows between 4 preceding and current row
          ),
          win10 as (
            partition by source, symbol
            order by bucket_start
            rows between 9 preceding and current row
          ),
          win30 as (
            partition by source, symbol
            order by bucket_start
            rows between 29 preceding and current row
          )
      ),
      scored as (
        select
          *,
          case
            when valid_sample_count_10s >= $8
              and spread_avg_10s > 0
              and spread_max_10s <= 1.50 * spread_avg_10s
              then true
            else false
          end as spread_stable_10s,
          case
            when valid_sample_count_30s >= $9
              and spread_avg_30s > 0
              and spread_max_30s <= 1.50 * spread_avg_30s
              then true
            else false
          end as spread_stable_30s,
          case
            when mid_price_10s_ago is not null
              and mid_price_10s_ago > 0
              and mid_price is not null
              then (mid_price - mid_price_10s_ago) / mid_price_10s_ago * 10000
            else null
          end as mid_change_10s_bps,
          case
            when mid_price_30s_ago is not null
              and mid_price_30s_ago > 0
              and mid_price is not null
              then (mid_price - mid_price_30s_ago) / mid_price_30s_ago * 10000
            else null
          end as mid_change_30s_bps,
          case
            when bucket_quality = 'stale' then 'stale'
            when bucket_quality = 'missing' then 'missing'
            when microprice_lean >= $7 then 'up'
            when microprice_lean <= -$7 then 'down'
            else 'neutral'
          end as lean_direction,
          case
            when prior_valid_lean >= $7 and microprice_lean <= -$7 then 'flip_down'
            when prior_valid_lean <= -$7 and microprice_lean >= $7 then 'flip_up'
            else 'none'
          end as flip_signal
        from stats
      ),
      classified_input as (
        select
          *,
          case
            when mid_change_10s_bps is not null
              and abs(mid_change_10s_bps) <= greatest(0.50, 2.0 * coalesce(spread_bps_close, 0))
              then true
            else false
          end as price_stalled_10s,
          case
            when mid_change_30s_bps is not null
              and abs(mid_change_30s_bps) <= greatest(0.75, 2.0 * coalesce(spread_bps_close, 0))
              then true
            else false
          end as price_stalled_30s
        from scored
      ),
      classified as (
        select
          *,
          case
            when bucket_quality not in ('complete', 'partial') then 'none'
            when avg_lean_30s >= $7
              and up_lean_share_30s >= 0.70
              and valid_sample_count_30s >= $9
              and spread_stable_30s
              then 'persistent_up_30s'
            when avg_lean_30s <= -$7
              and down_lean_share_30s >= 0.70
              and valid_sample_count_30s >= $9
              and spread_stable_30s
              then 'persistent_down_30s'
            when avg_lean_10s >= $7
              and up_lean_share_10s >= 0.70
              and valid_sample_count_10s >= $8
              and spread_stable_10s
              then 'persistent_up_10s'
            when avg_lean_10s <= -$7
              and down_lean_share_10s >= 0.70
              and valid_sample_count_10s >= $8
              and spread_stable_10s
              then 'persistent_down_10s'
            else 'none'
          end as persistence_signal
        from classified_input
      ),
      final_rows as (
        select
          *,
          case
            when persistence_signal = 'persistent_up_30s' and price_stalled_30s then 'up_pressure_absorbed'
            when persistence_signal = 'persistent_down_30s' and price_stalled_30s then 'down_pressure_absorbed'
            when persistence_signal = 'persistent_up_10s' and price_stalled_10s then 'up_pressure_absorbed'
            when persistence_signal = 'persistent_down_10s' and price_stalled_10s then 'down_pressure_absorbed'
            when flip_signal = 'flip_down' and price_stalled_10s then 'bearish_microprice_flip_while_stalled'
            when flip_signal = 'flip_up' and price_stalled_10s then 'bullish_microprice_flip_while_stalled'
            when persistence_signal = 'persistent_up_30s' then 'strong_upward_book_pressure'
            when persistence_signal = 'persistent_down_30s' then 'strong_downward_book_pressure'
            when persistence_signal = 'persistent_up_10s' then 'short_upward_book_pressure'
            when persistence_signal = 'persistent_down_10s' then 'short_downward_book_pressure'
            else 'neutral'
          end as microprice_behavior
        from classified
      )
      insert into market_microprice_buckets
        (
          market_id,
          source,
          symbol,
          bucket_start,
          bucket_end,
          bucket_seconds,
          source_summary_quality,
          book_ticker_update_count,
          seconds_since_book_update,
          best_bid_price,
          best_bid_qty,
          best_ask_price,
          best_ask_qty,
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
          microprice_behavior,
          bucket_quality,
          feature_version,
          updated_at
        )
      select
          market_id,
          source,
          symbol,
          bucket_start,
          bucket_end,
          bucket_seconds,
          source_summary_quality,
          book_ticker_update_count,
          seconds_since_book_update,
          best_bid_price,
          best_bid_qty,
          best_ask_price,
          best_ask_qty,
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
          microprice_behavior,
          bucket_quality,
          $10,
          now()
      from final_rows
      on conflict (market_id, source, bucket_start) do update set
        symbol = excluded.symbol,
        bucket_end = excluded.bucket_end,
        bucket_seconds = excluded.bucket_seconds,
        source_summary_quality = excluded.source_summary_quality,
        book_ticker_update_count = excluded.book_ticker_update_count,
        seconds_since_book_update = excluded.seconds_since_book_update,
        best_bid_price = excluded.best_bid_price,
        best_bid_qty = excluded.best_bid_qty,
        best_ask_price = excluded.best_ask_price,
        best_ask_qty = excluded.best_ask_qty,
        mid_price = excluded.mid_price,
        spread_bps_close = excluded.spread_bps_close,
        spread_bps_avg = excluded.spread_bps_avg,
        spread_bps_max = excluded.spread_bps_max,
        microprice = excluded.microprice,
        microprice_bps_from_mid = excluded.microprice_bps_from_mid,
        microprice_lean = excluded.microprice_lean,
        microprice_delta = excluded.microprice_delta,
        lean_delta_1s = excluded.lean_delta_1s,
        ewma_lean_3s = excluded.ewma_lean_3s,
        avg_lean_5s = excluded.avg_lean_5s,
        microprice_pressure_market = excluded.microprice_pressure_market,
        microprice_pressure_continuous = excluded.microprice_pressure_continuous,
        avg_lean_10s = excluded.avg_lean_10s,
        avg_lean_30s = excluded.avg_lean_30s,
        up_lean_share_10s = excluded.up_lean_share_10s,
        down_lean_share_10s = excluded.down_lean_share_10s,
        up_lean_share_30s = excluded.up_lean_share_30s,
        down_lean_share_30s = excluded.down_lean_share_30s,
        valid_sample_count_10s = excluded.valid_sample_count_10s,
        valid_sample_count_30s = excluded.valid_sample_count_30s,
        spread_stable_10s = excluded.spread_stable_10s,
        spread_stable_30s = excluded.spread_stable_30s,
        mid_change_10s_bps = excluded.mid_change_10s_bps,
        mid_change_30s_bps = excluded.mid_change_30s_bps,
        price_stalled_10s = excluded.price_stalled_10s,
        price_stalled_30s = excluded.price_stalled_30s,
        lean_direction = excluded.lean_direction,
        persistence_signal = excluded.persistence_signal,
        flip_signal = excluded.flip_signal,
        microprice_behavior = excluded.microprice_behavior,
        bucket_quality = excluded.bucket_quality,
        feature_version = excluded.feature_version,
        updated_at = now()
      returning bucket_quality
    `,
    [
      market.symbol,
      source.source,
      market.start,
      market.end,
      market.id,
      STALE_BOOK_SECONDS,
      LEAN_THRESHOLD,
      MIN_VALID_10S,
      MIN_VALID_30S,
      FEATURE_VERSION,
    ]
  );

  const qualityCounts = result.rows.reduce((counts, row) => {
    counts[row.bucket_quality] = (counts[row.bucket_quality] || 0) + 1;
    return counts;
  }, {});

  return {
    source: source.source,
    micropriceBucketCount: result.rowCount,
    completeCount: qualityCounts.complete || 0,
    partialCount: qualityCounts.partial || 0,
    staleCount: qualityCounts.stale || 0,
    missingCount: qualityCounts.missing || 0,
  };
}

export async function refreshRecentMicropriceBuckets(limit = 4) {
  const source = FUTURES_WEBSOCKET_SOURCE;
  const result = await query(
    `
      with target_markets as (
        select m.id, m.symbol, m.start_time, m.end_time
        from markets m
        where m.status <> 'open'
          and exists (
            select 1
            from futures_ws_1s_summaries s
            where s.symbol = m.symbol
              and s.source = $1
              and s.bucket_start >= m.start_time
              and s.bucket_start < m.end_time
          )
        order by m.end_time desc
        limit $2
      )
      select *
      from target_markets
      order by start_time asc
    `,
    [source.source, limit]
  );

  let micropriceBucketCount = 0;
  for (const row of result.rows) {
    const written = await writeMarketMicropriceBuckets(rowToMarket(row));
    micropriceBucketCount += written.micropriceBucketCount;
  }

  return {
    source: source.source,
    marketCount: result.rowCount,
    micropriceBucketCount,
  };
}
