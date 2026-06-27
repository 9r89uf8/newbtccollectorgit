import { query } from "../lib/db.js";
import { FUTURES_MICROSTRUCTURE_SOURCE } from "./config.mjs";

const FEATURE_VERSION = "market-classification-v1";
const TREND_RETURN_BPS = 8;
const LARGE_RETURN_BPS = 20;
const OI_CHANGE_PCT_THRESHOLD = 0.05;
const TAKER_IMBALANCE_THRESHOLD = 0.12;
const ABSORPTION_RETURN_BPS = 5;
const ABSORPTION_TAKER_IMBALANCE = 0.25;

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function addTag(tags, tag) {
  if (tag && !tags.includes(tag)) tags.push(tag);
}

function confidenceWithQuality(base, row, usesPositioning = false) {
  let confidence = base;
  if (row.behavior_quality === "complete") confidence += 0.08;
  if (row.feature_quality === "complete") confidence += 0.08;
  if (usesPositioning && row.position_quality === "complete") confidence += 0.08;
  if (usesPositioning && row.position_quality === "partial") confidence += 0.03;
  return Math.min(0.95, confidence);
}

function fallbackClass(row, returnBps, rangeBps) {
  const shape = row.shape_class || "unknown";
  const volatility = row.volatility_class || "unknown";
  const direction = row.direction || "flat";

  if (shape === "range" && volatility === "quiet") return "quiet_range";
  if (shape === "spike_fade") return "spike_fade";
  if (shape === "reversal") return direction === "down" ? "reversal_down" : "reversal_up";
  if (shape === "trend") return returnBps < 0 ? "trend_down" : "trend_up";
  if (Number.isFinite(rangeBps) && rangeBps < 8) return "quiet_range";
  return direction === "down" ? "range_down" : direction === "up" ? "range_up" : "range";
}

function classifyRow(row) {
  const tags = [];
  const reasons = [];
  const returnPct = toNumber(row.return_pct);
  const returnBps = returnPct === null ? null : returnPct * 100;
  const rangeBps = toNumber(row.range_bps);
  const takerImbalance = toNumber(row.taker_imbalance);
  const oiChangePct = toNumber(row.open_interest_change_pct);
  const premiumChangeBps = toNumber(row.premium_bps_change);
  const hasBehavior = row.behavior_quality && row.behavior_quality !== "missing";
  const hasPositioning = row.position_quality && row.position_quality !== "missing" && oiChangePct !== null;

  addTag(tags, row.magnitude_class && `magnitude_${row.magnitude_class}`);
  addTag(tags, row.volatility_class && `volatility_${row.volatility_class}`);
  addTag(tags, row.close_location_class && `close_${row.close_location_class}`);
  if (!hasPositioning) addTag(tags, "positioning_missing");
  if (row.position_quality === "partial") addTag(tags, "positioning_partial");
  if (premiumChangeBps !== null && premiumChangeBps > 1) addTag(tags, "premium_expanding");
  if (premiumChangeBps !== null && premiumChangeBps < -1) addTag(tags, "premium_contracting");

  if (!hasBehavior || returnBps === null) {
    reasons.push("No usable behavior label was available for this market.");
    return {
      primaryClass: "unclassified",
      secondaryTags: tags,
      confidence: 0.2,
      reasons,
    };
  }

  if (hasPositioning && takerImbalance !== null) {
    if (
      returnBps >= TREND_RETURN_BPS &&
      oiChangePct >= OI_CHANGE_PCT_THRESHOLD &&
      takerImbalance >= TAKER_IMBALANCE_THRESHOLD
    ) {
      reasons.push("Price rose while open interest increased and taker flow was buy-heavy.");
      return {
        primaryClass: "long_build",
        secondaryTags: tags,
        confidence: confidenceWithQuality(0.68, row, true),
        reasons,
      };
    }

    if (
      returnBps <= -TREND_RETURN_BPS &&
      oiChangePct >= OI_CHANGE_PCT_THRESHOLD &&
      takerImbalance <= -TAKER_IMBALANCE_THRESHOLD
    ) {
      reasons.push("Price fell while open interest increased and taker flow was sell-heavy.");
      return {
        primaryClass: "short_build",
        secondaryTags: tags,
        confidence: confidenceWithQuality(0.68, row, true),
        reasons,
      };
    }

    if (
      returnBps >= TREND_RETURN_BPS &&
      oiChangePct <= -OI_CHANGE_PCT_THRESHOLD &&
      takerImbalance >= TAKER_IMBALANCE_THRESHOLD
    ) {
      reasons.push("Price rose while open interest fell and taker flow was buy-heavy.");
      return {
        primaryClass: "short_squeeze",
        secondaryTags: tags,
        confidence: confidenceWithQuality(0.7, row, true),
        reasons,
      };
    }

    if (
      returnBps <= -TREND_RETURN_BPS &&
      oiChangePct <= -OI_CHANGE_PCT_THRESHOLD &&
      takerImbalance <= -TAKER_IMBALANCE_THRESHOLD
    ) {
      reasons.push("Price fell while open interest fell and taker flow was sell-heavy.");
      return {
        primaryClass: "long_squeeze",
        secondaryTags: tags,
        confidence: confidenceWithQuality(0.7, row, true),
        reasons,
      };
    }

    if (Math.abs(returnBps) >= LARGE_RETURN_BPS && oiChangePct <= -OI_CHANGE_PCT_THRESHOLD) {
      reasons.push("A large price move occurred while open interest dropped.");
      return {
        primaryClass: "deleveraging",
        secondaryTags: tags,
        confidence: confidenceWithQuality(0.62, row, true),
        reasons,
      };
    }
  }

  if (
    takerImbalance !== null &&
    Math.abs(returnBps) <= ABSORPTION_RETURN_BPS &&
    Math.abs(takerImbalance) >= ABSORPTION_TAKER_IMBALANCE &&
    rangeBps !== null &&
    rangeBps >= 8
  ) {
    const primaryClass = takerImbalance > 0 ? "buy_pressure_absorbed" : "sell_pressure_absorbed";
    reasons.push("Aggressive flow was one-sided, but open-to-close price movement stayed muted.");
    return {
      primaryClass,
      secondaryTags: tags,
      confidence: confidenceWithQuality(0.6, row, false),
      reasons,
    };
  }

  const primaryClass = fallbackClass(row, returnBps, rangeBps);
  reasons.push(`Fallback behavior label shape was ${row.shape_class || "unknown"}.`);

  return {
    primaryClass,
    secondaryTags: tags,
    confidence: confidenceWithQuality(0.48, row, false),
    reasons,
  };
}

async function readClassificationInputs(market, source) {
  const result = await query(
    `
      select
        ml.return_pct,
        ml.direction,
        ml.quality as price_label_quality,
        mbl.range_bps,
        mbl.shape_class,
        mbl.magnitude_class,
        mbl.close_location_class,
        mbl.volatility_class,
        mbl.label_quality as behavior_quality,
        mf.taker_imbalance,
        mf.net_taker_quote,
        mf.feature_quality,
        mpf.open_interest_change_pct,
        mpf.open_interest_change_quote,
        mpf.premium_bps_change,
        mpf.position_quality
      from markets m
      left join market_labels ml
        on ml.market_id = m.id
       and ml.source = $2
      left join market_behavior_labels mbl
        on mbl.market_id = m.id
       and mbl.source = $2
      left join market_features mf
        on mf.market_id = m.id
       and mf.source = $2
      left join market_position_features mpf
        on mpf.market_id = m.id
       and mpf.source = $2
      where m.id = $1
      limit 1
    `,
    [market.id, source.source]
  );

  return result.rows[0] || null;
}

export async function writeMarketClassification(market) {
  const source = FUTURES_MICROSTRUCTURE_SOURCE;
  const row = await readClassificationInputs(market, source);
  const classification = row
    ? classifyRow(row)
    : {
        primaryClass: "unclassified",
        secondaryTags: ["inputs_missing"],
        confidence: 0.1,
        reasons: ["Market classification inputs were missing."],
      };

  const result = await query(
    `
      insert into market_classifications
        (
          market_id,
          source,
          symbol,
          primary_class,
          secondary_tags,
          confidence,
          feature_version,
          reasons,
          updated_at
        )
      values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())
      on conflict (market_id, source) do update set
        symbol = excluded.symbol,
        primary_class = excluded.primary_class,
        secondary_tags = excluded.secondary_tags,
        confidence = excluded.confidence,
        feature_version = excluded.feature_version,
        reasons = excluded.reasons,
        updated_at = now()
      returning *
    `,
    [
      market.id,
      source.source,
      market.symbol,
      classification.primaryClass,
      classification.secondaryTags,
      classification.confidence,
      FEATURE_VERSION,
      JSON.stringify(classification.reasons),
    ]
  );

  return result.rows[0] || null;
}
