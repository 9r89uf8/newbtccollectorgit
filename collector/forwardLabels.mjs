import { query } from "../lib/db.js";
import {
  FORWARD_LABEL_HORIZONS_SECONDS,
  FORWARD_LABEL_MIN_THRESHOLD_BPS,
  FUTURES_WEBSOCKET_SOURCE,
} from "./config.mjs";

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

export async function writeMarketForwardLabels(market) {
  const source = FUTURES_WEBSOCKET_SOURCE;

  const result = await query(
    `
      with horizons as (
        select unnest($5::int[]) as horizon_seconds
      ),
      base as (
        select *
        from futures_ws_1s_summaries
        where symbol = $1
          and source = $2
          and bucket_start >= $3
          and bucket_start < $4
          and mid_price_close is not null
      ),
      base_horizons as (
        select
          b.*,
          h.horizon_seconds,
          b.bucket_start + (h.horizon_seconds * interval '1 second') as future_bucket_start,
          greatest(
            $6::numeric,
            coalesce(b.spread_bps_avg, b.spread_bps_close, 0) * 2
          ) as threshold_bps
        from base b
        cross join horizons h
      ),
      scored as (
        select
          bh.*,
          future.mid_price_close as future_price,
          coalesce(path.path_sample_count, 0) as path_sample_count,
          path.high_price,
          path.low_price,
          up_hit.first_up_at,
          down_hit.first_down_at
        from base_horizons bh
        left join futures_ws_1s_summaries future
          on future.symbol = $1
         and future.source = $2
         and future.bucket_start = bh.future_bucket_start
         and future.mid_price_close is not null
        left join lateral (
          select
            count(*)::int as path_sample_count,
            max(coalesce(p.mid_price_high, p.mid_price_close)) as high_price,
            min(coalesce(p.mid_price_low, p.mid_price_close)) as low_price
          from futures_ws_1s_summaries p
          where p.symbol = $1
            and p.source = $2
            and p.bucket_start > bh.bucket_start
            and p.bucket_start <= bh.future_bucket_start
            and p.mid_price_close is not null
        ) path on true
        left join lateral (
          select min(p.bucket_start) as first_up_at
          from futures_ws_1s_summaries p
          where p.symbol = $1
            and p.source = $2
            and p.bucket_start > bh.bucket_start
            and p.bucket_start <= bh.future_bucket_start
            and coalesce(p.mid_price_high, p.mid_price_close) >=
              bh.mid_price_close * (1 + (bh.threshold_bps / 10000))
        ) up_hit on true
        left join lateral (
          select min(p.bucket_start) as first_down_at
          from futures_ws_1s_summaries p
          where p.symbol = $1
            and p.source = $2
            and p.bucket_start > bh.bucket_start
            and p.bucket_start <= bh.future_bucket_start
            and coalesce(p.mid_price_low, p.mid_price_close) <=
              bh.mid_price_close * (1 - (bh.threshold_bps / 10000))
        ) down_hit on true
      )
      insert into market_forward_labels
        (
          market_id,
          source,
          symbol,
          bucket_start,
          horizon_seconds,
          price_now,
          future_price,
          forward_return_bps,
          future_max_up_bps,
          future_max_down_bps,
          threshold_bps,
          hit_up_threshold,
          hit_down_threshold,
          hit_up_before_down,
          direction_label,
          path_sample_count,
          quality,
          updated_at
        )
      select
        $7,
        $2,
        $1,
        bucket_start,
        horizon_seconds,
        mid_price_close,
        future_price,
        case
          when future_price is not null and mid_price_close > 0
            then ((future_price - mid_price_close) / mid_price_close) * 10000
          else null
        end as forward_return_bps,
        case
          when high_price is not null and mid_price_close > 0
            then ((high_price - mid_price_close) / mid_price_close) * 10000
          else null
        end as future_max_up_bps,
        case
          when low_price is not null and mid_price_close > 0
            then ((low_price - mid_price_close) / mid_price_close) * 10000
          else null
        end as future_max_down_bps,
        threshold_bps,
        coalesce(
          high_price is not null
            and mid_price_close > 0
            and ((high_price - mid_price_close) / mid_price_close) * 10000 >= threshold_bps,
          false
        ) as hit_up_threshold,
        coalesce(
          low_price is not null
            and mid_price_close > 0
            and ((low_price - mid_price_close) / mid_price_close) * 10000 <= -threshold_bps,
          false
        ) as hit_down_threshold,
        case
          when first_up_at is null and first_down_at is null then null
          when first_up_at is null then false
          when first_down_at is null then true
          when first_up_at = first_down_at then null
          else first_up_at < first_down_at
        end as hit_up_before_down,
        case
          when future_price is null or mid_price_close <= 0 then 'unknown'
          when ((future_price - mid_price_close) / mid_price_close) * 10000 >= threshold_bps then 'up'
          when ((future_price - mid_price_close) / mid_price_close) * 10000 <= -threshold_bps then 'down'
          else 'flat'
        end as direction_label,
        path_sample_count,
        case
          when future_price is null then 'missing'
          when path_sample_count >= horizon_seconds then 'complete'
          else 'partial'
        end as quality,
        now()
      from scored
      on conflict (source, symbol, bucket_start, horizon_seconds) do update set
        market_id = excluded.market_id,
        price_now = excluded.price_now,
        future_price = excluded.future_price,
        forward_return_bps = excluded.forward_return_bps,
        future_max_up_bps = excluded.future_max_up_bps,
        future_max_down_bps = excluded.future_max_down_bps,
        threshold_bps = excluded.threshold_bps,
        hit_up_threshold = excluded.hit_up_threshold,
        hit_down_threshold = excluded.hit_down_threshold,
        hit_up_before_down = excluded.hit_up_before_down,
        direction_label = excluded.direction_label,
        path_sample_count = excluded.path_sample_count,
        quality = excluded.quality,
        updated_at = now()
      returning horizon_seconds
    `,
    [
      market.symbol,
      source.source,
      market.start,
      market.end,
      FORWARD_LABEL_HORIZONS_SECONDS,
      FORWARD_LABEL_MIN_THRESHOLD_BPS,
      market.id,
    ]
  );

  return {
    source: source.source,
    labelCount: result.rowCount,
  };
}

export async function refreshRecentForwardLabels(limit = 4) {
  const maxHorizonSeconds = Math.max(...FORWARD_LABEL_HORIZONS_SECONDS);
  const result = await query(
    `
      select id, symbol, start_time, end_time
      from markets
      where status <> 'open'
        and end_time <= now() - ($1 * interval '1 second')
      order by end_time desc
      limit $2
    `,
    [maxHorizonSeconds, limit]
  );

  let labelCount = 0;
  for (const row of result.rows) {
    const written = await writeMarketForwardLabels(rowToMarket(row));
    labelCount += written.labelCount;
  }

  return {
    marketCount: result.rowCount,
    labelCount,
  };
}
