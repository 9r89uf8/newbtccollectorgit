import { query } from "../lib/db.js";
import {
  BASIS_SAMPLE_PERIOD,
  EXPECTED_POSITION_SAMPLES_PER_MARKET,
  FUTURES_BASIS_CONTRACT_TYPE,
  FUTURES_MICROSTRUCTURE_SOURCE,
} from "./config.mjs";

export async function writeMarketPositionFeatures(market) {
  const source = FUTURES_MICROSTRUCTURE_SOURCE;

  const result = await query(
    `
      with samples as (
        select *
        from derivative_position_samples
        where symbol = $1
          and source = $2
          and scheduled_at >= $3
          and scheduled_at < $4
      ),
      counts as (
        select count(*)::int as sample_count
        from samples
      ),
      first_sample as (
        select *
        from samples
        order by scheduled_at asc
        limit 1
      ),
      last_sample as (
        select *
        from samples
        order by scheduled_at desc
        limit 1
      ),
      stats as (
        select
          min(premium_bps) as premium_bps_min,
          max(premium_bps) as premium_bps_max,
          avg(premium_bps) as premium_bps_avg,
          min(open_interest_base) as open_interest_base_min,
          max(open_interest_base) as open_interest_base_max,
          min(open_interest_quote) as open_interest_quote_min,
          max(open_interest_quote) as open_interest_quote_max
        from samples
      ),
      basis_window as (
        select *
        from futures_basis_samples
        where pair = $1
          and source = $2
          and contract_type = $7
          and period = $8
          and basis_time >= $3::timestamptz - interval '5 minutes'
          and basis_time <= $4::timestamptz + interval '5 minutes'
      ),
      basis_current as (
        select *
        from basis_window
        where basis_time >= $3
          and basis_time <= $4
        order by basis_time desc
        limit 1
      ),
      basis_previous as (
        select previous.*
        from futures_basis_samples previous
        left join basis_current current_basis on true
        where previous.pair = $1
          and previous.source = $2
          and previous.contract_type = $7
          and previous.period = $8
          and previous.basis_time < coalesce(current_basis.basis_time, $3::timestamptz)
        order by previous.basis_time desc
        limit 1
      ),
      basis_counts as (
        select count(*)::int as basis_sample_count
        from basis_window
        where basis_time >= $3
          and basis_time <= $4
      ),
      features as (
        select
          counts.sample_count,
          first_sample.mark_price as mark_price_start,
          last_sample.mark_price as mark_price_end,
          first_sample.index_price as index_price_start,
          last_sample.index_price as index_price_end,
          first_sample.premium_bps as premium_bps_start,
          last_sample.premium_bps as premium_bps_end,
          stats.premium_bps_min,
          stats.premium_bps_max,
          stats.premium_bps_avg,
          last_sample.premium_bps - first_sample.premium_bps as premium_bps_change,
          last_sample.funding_rate,
          case
            when last_sample.next_funding_time is not null
              then extract(epoch from (last_sample.next_funding_time - $4::timestamptz)) / 60
            else null
          end as minutes_to_funding,
          first_sample.open_interest_base as open_interest_base_start,
          last_sample.open_interest_base as open_interest_base_end,
          stats.open_interest_base_min,
          stats.open_interest_base_max,
          first_sample.open_interest_quote as open_interest_quote_start,
          last_sample.open_interest_quote as open_interest_quote_end,
          stats.open_interest_quote_min,
          stats.open_interest_quote_max,
          last_sample.open_interest_base - first_sample.open_interest_base as open_interest_change_base,
          last_sample.open_interest_quote - first_sample.open_interest_quote as open_interest_change_quote,
          (
            (last_sample.open_interest_quote - first_sample.open_interest_quote)
            / nullif(first_sample.open_interest_quote, 0)
          ) * 100 as open_interest_change_pct,
          basis_counts.basis_sample_count,
          basis_current.basis_time,
          basis_current.index_price as basis_index_price,
          basis_current.futures_price as basis_futures_price,
          basis_current.basis,
          basis_current.basis_rate,
          basis_current.basis_bps,
          basis_previous.basis_bps as basis_bps_previous,
          basis_current.basis_bps - basis_previous.basis_bps as basis_bps_change,
          case
            when basis_current.basis_time is null then 'missing'
            else 'complete'
          end as basis_quality,
          case
            when counts.sample_count = 0 then 'missing'
            when counts.sample_count >= $5 then 'complete'
            else 'partial'
          end as position_quality
        from counts
        left join first_sample on true
        left join last_sample on true
        left join stats on true
        left join basis_counts on true
        left join basis_current on true
        left join basis_previous on true
      )
      insert into market_position_features
        (
          market_id,
          source,
          symbol,
          sample_count,
          mark_price_start,
          mark_price_end,
          index_price_start,
          index_price_end,
          premium_bps_start,
          premium_bps_end,
          premium_bps_min,
          premium_bps_max,
          premium_bps_avg,
          premium_bps_change,
          funding_rate,
          minutes_to_funding,
          open_interest_base_start,
          open_interest_base_end,
          open_interest_base_min,
          open_interest_base_max,
          open_interest_quote_start,
          open_interest_quote_end,
          open_interest_quote_min,
          open_interest_quote_max,
          open_interest_change_base,
          open_interest_change_quote,
          open_interest_change_pct,
          basis_sample_count,
          basis_time,
          basis_index_price,
          basis_futures_price,
          basis,
          basis_rate,
          basis_bps,
          basis_bps_previous,
          basis_bps_change,
          basis_quality,
          position_quality,
          updated_at
        )
      select
        $6,
        $2,
        $1,
        sample_count,
        mark_price_start,
        mark_price_end,
        index_price_start,
        index_price_end,
        premium_bps_start,
        premium_bps_end,
        premium_bps_min,
        premium_bps_max,
        premium_bps_avg,
        premium_bps_change,
        funding_rate,
        minutes_to_funding,
        open_interest_base_start,
        open_interest_base_end,
        open_interest_base_min,
        open_interest_base_max,
        open_interest_quote_start,
        open_interest_quote_end,
        open_interest_quote_min,
        open_interest_quote_max,
        open_interest_change_base,
        open_interest_change_quote,
        open_interest_change_pct,
        basis_sample_count,
        basis_time,
        basis_index_price,
        basis_futures_price,
        basis,
        basis_rate,
        basis_bps,
        basis_bps_previous,
        basis_bps_change,
        basis_quality,
        position_quality,
        now()
      from features
      on conflict (market_id, source) do update set
        symbol = excluded.symbol,
        sample_count = excluded.sample_count,
        mark_price_start = excluded.mark_price_start,
        mark_price_end = excluded.mark_price_end,
        index_price_start = excluded.index_price_start,
        index_price_end = excluded.index_price_end,
        premium_bps_start = excluded.premium_bps_start,
        premium_bps_end = excluded.premium_bps_end,
        premium_bps_min = excluded.premium_bps_min,
        premium_bps_max = excluded.premium_bps_max,
        premium_bps_avg = excluded.premium_bps_avg,
        premium_bps_change = excluded.premium_bps_change,
        funding_rate = excluded.funding_rate,
        minutes_to_funding = excluded.minutes_to_funding,
        open_interest_base_start = excluded.open_interest_base_start,
        open_interest_base_end = excluded.open_interest_base_end,
        open_interest_base_min = excluded.open_interest_base_min,
        open_interest_base_max = excluded.open_interest_base_max,
        open_interest_quote_start = excluded.open_interest_quote_start,
        open_interest_quote_end = excluded.open_interest_quote_end,
        open_interest_quote_min = excluded.open_interest_quote_min,
        open_interest_quote_max = excluded.open_interest_quote_max,
        open_interest_change_base = excluded.open_interest_change_base,
        open_interest_change_quote = excluded.open_interest_change_quote,
        open_interest_change_pct = excluded.open_interest_change_pct,
        basis_sample_count = excluded.basis_sample_count,
        basis_time = excluded.basis_time,
        basis_index_price = excluded.basis_index_price,
        basis_futures_price = excluded.basis_futures_price,
        basis = excluded.basis,
        basis_rate = excluded.basis_rate,
        basis_bps = excluded.basis_bps,
        basis_bps_previous = excluded.basis_bps_previous,
        basis_bps_change = excluded.basis_bps_change,
        basis_quality = excluded.basis_quality,
        position_quality = excluded.position_quality,
        updated_at = now()
      returning *
    `,
    [
      market.symbol,
      source.source,
      market.start,
      market.end,
      EXPECTED_POSITION_SAMPLES_PER_MARKET,
      market.id,
      FUTURES_BASIS_CONTRACT_TYPE,
      BASIS_SAMPLE_PERIOD,
    ]
  );

  return result.rows[0] || null;
}
