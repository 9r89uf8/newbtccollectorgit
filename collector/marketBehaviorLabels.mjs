import { query } from "../lib/db.js";
import { FUTURES_MICROSTRUCTURE_SOURCE } from "./config.mjs";

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function classifyMagnitude(returnBps) {
  const absReturnBps = Math.abs(returnBps);
  if (!Number.isFinite(absReturnBps)) return "unknown";
  if (absReturnBps < 2) return "tiny";
  if (absReturnBps < 8) return "small";
  if (absReturnBps < 20) return "medium";
  if (absReturnBps < 50) return "large";
  return "extreme";
}

function classifyVolatility(rangeBps) {
  if (!Number.isFinite(rangeBps)) return "unknown";
  if (rangeBps < 8) return "quiet";
  if (rangeBps < 20) return "normal";
  if (rangeBps < 50) return "volatile";
  return "shock";
}

function classifyCloseLocation(closeLocation) {
  if (!Number.isFinite(closeLocation)) return "unknown";
  if (closeLocation <= 0.25) return "near_low";
  if (closeLocation >= 0.75) return "near_high";
  return "middle";
}

function classifyShape({ returnBps, rangeBps, closeLocation, priceReversalCount }) {
  if (!Number.isFinite(returnBps) || !Number.isFinite(rangeBps)) return "unknown";
  if (rangeBps < 8) return "range";

  const absReturnBps = Math.abs(returnBps);
  const closeMatchesDirection =
    (returnBps > 0 && closeLocation >= 0.7) ||
    (returnBps < 0 && closeLocation <= 0.3);

  if (rangeBps >= 12 && absReturnBps <= Math.max(3, rangeBps * 0.25)) {
    return "spike_fade";
  }

  if (closeMatchesDirection && absReturnBps >= Math.max(6, rangeBps * 0.4)) {
    return "trend";
  }

  if (priceReversalCount >= 2 && rangeBps >= 12) {
    return "reversal";
  }

  return "range";
}

async function readBehaviorStats(market, source) {
  const result = await query(
    `
      with base as (
        select
          $1::text as symbol,
          $2::text as source,
          $3::timestamptz as start_time,
          $4::timestamptz as end_time,
          $5::text as market_id
      ),
      label as (
        select open_price, close_price, return_pct, quality
        from market_labels ml, base
        where ml.market_id = base.market_id
          and ml.source = base.source
      ),
      price_points as (
        select ps.scheduled_at as point_time, ps.price
        from price_samples ps, base
        where ps.symbol = base.symbol
          and ps.source = base.source
          and ps.scheduled_at >= base.start_time
          and ps.scheduled_at <= base.end_time
        union all
        select at.trade_time as point_time, at.price
        from agg_trades at, base
        where at.symbol = base.symbol
          and at.source = base.source
          and at.trade_time >= base.start_time
          and at.trade_time < base.end_time
      ),
      point_count as (
        select count(*)::int as point_count
        from price_points
      ),
      high_point as (
        select point_time as high_time, price as high_price
        from price_points
        order by price desc, point_time asc
        limit 1
      ),
      low_point as (
        select point_time as low_time, price as low_price
        from price_points
        order by price asc, point_time asc
        limit 1
      ),
      sample_series as (
        select
          ps.scheduled_at as point_time,
          ps.price,
          lag(ps.price) over (order by ps.scheduled_at) as previous_price,
          lag(ps.scheduled_at) over (order by ps.scheduled_at) as previous_time
        from price_samples ps, base
        where ps.symbol = base.symbol
          and ps.source = base.source
          and ps.scheduled_at >= base.start_time
          and ps.scheduled_at <= base.end_time
      ),
      sample_returns as (
        select
          point_time,
          extract(epoch from (point_time - previous_time)) as gap_seconds,
          ((price - previous_price) / previous_price) * 10000 as return_bps,
          abs(((price - previous_price) / previous_price) * 10000) as abs_return_bps,
          sign(price - previous_price)::int as direction_sign
        from sample_series
        where previous_price is not null
          and previous_time is not null
          and previous_price > 0
      ),
      non_zero_returns as (
        select
          direction_sign,
          lag(direction_sign) over (order by point_time) as previous_direction_sign
        from sample_returns
        where direction_sign <> 0
      ),
      reversals as (
        select coalesce(
          count(*) filter (
            where previous_direction_sign is not null
              and direction_sign <> previous_direction_sign
          ),
          0
        )::int as price_reversal_count
        from non_zero_returns
      ),
      vol_stats as (
        select
          sqrt(coalesce(sum(power(return_bps, 2)), 0)) as realized_vol_bps,
          max(abs_return_bps) filter (where gap_seconds <= 1.5) as largest_1s_return_bps,
          max(abs_return_bps) filter (where gap_seconds <= 5.5) as largest_5s_return_bps
        from sample_returns
      ),
      trade_stats as (
        select
          sum(quote_notional) / nullif(sum(quantity), 0) as trade_vwap
        from agg_trades at, base
        where at.symbol = base.symbol
          and at.source = base.source
          and at.trade_time >= base.start_time
          and at.trade_time < base.end_time
      )
      select
        label.open_price,
        label.close_price,
        label.return_pct,
        label.quality as label_quality,
        point_count.point_count,
        high_point.high_price,
        high_point.high_time,
        low_point.low_price,
        low_point.low_time,
        vol_stats.realized_vol_bps,
        vol_stats.largest_1s_return_bps,
        vol_stats.largest_5s_return_bps,
        reversals.price_reversal_count,
        trade_stats.trade_vwap
      from base
      left join label on true
      left join point_count on true
      left join high_point on true
      left join low_point on true
      left join vol_stats on true
      left join reversals on true
      left join trade_stats on true
    `,
    [market.symbol, source.source, market.start, market.end, market.id]
  );

  return result.rows[0] || null;
}

async function insertBehaviorLabel(market, source, values) {
  const result = await query(
    `
      insert into market_behavior_labels
        (
          market_id,
          source,
          symbol,
          high_price,
          high_time,
          low_price,
          low_time,
          range_bps,
          close_location,
          max_up_bps_from_open,
          max_down_bps_from_open,
          realized_vol_bps,
          trade_vwap,
          vwap_deviation_bps,
          largest_1s_return_bps,
          largest_5s_return_bps,
          price_reversal_count,
          magnitude_class,
          shape_class,
          close_location_class,
          volatility_class,
          label_quality,
          updated_at
        )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, now()
      )
      on conflict (market_id, source) do update set
        symbol = excluded.symbol,
        high_price = excluded.high_price,
        high_time = excluded.high_time,
        low_price = excluded.low_price,
        low_time = excluded.low_time,
        range_bps = excluded.range_bps,
        close_location = excluded.close_location,
        max_up_bps_from_open = excluded.max_up_bps_from_open,
        max_down_bps_from_open = excluded.max_down_bps_from_open,
        realized_vol_bps = excluded.realized_vol_bps,
        trade_vwap = excluded.trade_vwap,
        vwap_deviation_bps = excluded.vwap_deviation_bps,
        largest_1s_return_bps = excluded.largest_1s_return_bps,
        largest_5s_return_bps = excluded.largest_5s_return_bps,
        price_reversal_count = excluded.price_reversal_count,
        magnitude_class = excluded.magnitude_class,
        shape_class = excluded.shape_class,
        close_location_class = excluded.close_location_class,
        volatility_class = excluded.volatility_class,
        label_quality = excluded.label_quality,
        updated_at = now()
      returning *
    `,
    [
      market.id,
      source.source,
      market.symbol,
      values.highPrice,
      values.highTime,
      values.lowPrice,
      values.lowTime,
      values.rangeBps,
      values.closeLocation,
      values.maxUpBpsFromOpen,
      values.maxDownBpsFromOpen,
      values.realizedVolBps,
      values.tradeVwap,
      values.vwapDeviationBps,
      values.largest1sReturnBps,
      values.largest5sReturnBps,
      values.priceReversalCount,
      values.magnitudeClass,
      values.shapeClass,
      values.closeLocationClass,
      values.volatilityClass,
      values.labelQuality,
    ]
  );

  return result.rows[0] || null;
}

export async function writeMarketBehaviorLabel(market) {
  const source = FUTURES_MICROSTRUCTURE_SOURCE;
  const row = await readBehaviorStats(market, source);

  const openPrice = toNumber(row?.open_price);
  const closePrice = toNumber(row?.close_price);
  const highPrice = toNumber(row?.high_price);
  const lowPrice = toNumber(row?.low_price);
  const returnPct = toNumber(row?.return_pct);
  const tradeVwap = toNumber(row?.trade_vwap);
  const pointCount = Number(row?.point_count || 0);
  const priceReversalCount = Number(row?.price_reversal_count || 0);

  const hasCorePrices =
    openPrice !== null &&
    closePrice !== null &&
    highPrice !== null &&
    lowPrice !== null &&
    openPrice > 0;
  const rangeBps = hasCorePrices ? ((highPrice - lowPrice) / openPrice) * 10000 : null;
  const closeLocation =
    hasCorePrices && highPrice > lowPrice ? (closePrice - lowPrice) / (highPrice - lowPrice) : null;
  const maxUpBpsFromOpen = hasCorePrices ? ((highPrice - openPrice) / openPrice) * 10000 : null;
  const maxDownBpsFromOpen = hasCorePrices ? ((lowPrice - openPrice) / openPrice) * 10000 : null;
  const returnBps = returnPct === null ? null : returnPct * 100;
  const vwapDeviationBps =
    closePrice !== null && tradeVwap !== null && tradeVwap > 0
      ? ((closePrice - tradeVwap) / tradeVwap) * 10000
      : null;
  const labelQuality = !row?.label_quality
    ? "missing"
    : row.label_quality === "complete" && pointCount > 0
      ? "complete"
      : "partial";

  const values = {
    highPrice,
    highTime: row?.high_time || null,
    lowPrice,
    lowTime: row?.low_time || null,
    rangeBps,
    closeLocation,
    maxUpBpsFromOpen,
    maxDownBpsFromOpen,
    realizedVolBps: toNumber(row?.realized_vol_bps),
    tradeVwap,
    vwapDeviationBps,
    largest1sReturnBps: toNumber(row?.largest_1s_return_bps),
    largest5sReturnBps: toNumber(row?.largest_5s_return_bps),
    priceReversalCount,
    magnitudeClass: returnBps === null ? "unknown" : classifyMagnitude(returnBps),
    shapeClass: classifyShape({
      returnBps,
      rangeBps,
      closeLocation,
      priceReversalCount,
    }),
    closeLocationClass: classifyCloseLocation(closeLocation),
    volatilityClass: classifyVolatility(rangeBps),
    labelQuality,
  };

  return insertBehaviorLabel(market, source, values);
}
