import { getMarketDetailData } from "./marketDetailData.js";

const SCHEMA_VERSION = "btc_5m_market_packet_v1";
const RETURN_WINDOWS_SECONDS = [1, 5, 15, 30, 60];

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().replace(".000Z", "Z");
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toInteger(value) {
  const number = toNumber(value);
  return number === null ? null : Math.trunc(number);
}

function secondsFromStart(value, startMs) {
  const iso = toIso(value);
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.round((time - startMs) / 1000);
}

function bySecond(rows, timeField, startMs) {
  const map = new Map();
  for (const row of rows || []) {
    const second = secondsFromStart(row[timeField], startMs);
    if (second === null) continue;
    map.set(second, row);
  }
  return map;
}

function marketSeconds(market) {
  const startMs = new Date(market.start_time).getTime();
  const endMs = new Date(market.end_time).getTime();
  const seconds = Math.round((endMs - startMs) / 1000);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 300;
}

function returnBps(currentPrice, priorPrice) {
  if (currentPrice === null || priorPrice === null || priorPrice <= 0) return null;
  return ((currentPrice - priorPrice) / priorPrice) * 10000;
}

function compactPriceSample(sample, startMs) {
  return {
    s: secondsFromStart(sample.scheduled_at, startMs),
    ts_utc: toIso(sample.scheduled_at),
    price: toNumber(sample.price),
    sample_type: sample.sample_type || null,
  };
}

function compactChainlinkSample(sample, startMs) {
  return {
    s: secondsFromStart(sample.scheduled_at, startMs),
    ts_utc: toIso(sample.scheduled_at),
    price: toNumber(sample.price),
    quality: sample.quality || null,
    tick_age_ms: toInteger(sample.tick_age_ms),
  };
}

function compactProbabilitySample(sample, startMs) {
  return {
    s: secondsFromStart(sample.scheduled_at, startMs),
    ts_utc: toIso(sample.scheduled_at),
    up: toNumber(sample.up_probability),
    down: toNumber(sample.down_probability),
    up_normalized: toNumber(sample.up_probability_normalized),
    down_normalized: toNumber(sample.down_probability_normalized),
    quality: sample.quality || null,
  };
}

function compactFeatureBucket(bucket, startMs) {
  return {
    s: secondsFromStart(bucket.bucket_start, startMs),
    ts_utc: toIso(bucket.bucket_start),
    bucket_seconds: toNumber(bucket.bucket_seconds),
    return_pct: toNumber(bucket.return_pct),
    direction: bucket.direction || null,
    net_taker_quote: toNumber(bucket.net_taker_quote),
    total_volume_quote: toNumber(bucket.total_volume_quote),
    cvd_market_quote: toNumber(bucket.cvd_market_quote),
    taker_imbalance: toNumber(bucket.taker_imbalance),
    book_imbalance_5bps: toNumber(bucket.book_imbalance_5bps),
    spread_bps: toNumber(bucket.spread_bps),
    bid_depth_5bps: toNumber(bucket.bid_depth_5bps),
    ask_depth_5bps: toNumber(bucket.ask_depth_5bps),
    quality: bucket.bucket_quality || null,
  };
}

function compactPositionSample(sample, startMs, openInterestBase) {
  const openInterestQuote = toNumber(sample.open_interest_quote);
  return {
    s: secondsFromStart(sample.scheduled_at, startMs),
    ts_utc: toIso(sample.scheduled_at),
    open_interest_quote: openInterestQuote,
    open_interest_change_quote:
      openInterestQuote === null || openInterestBase === null
        ? null
        : openInterestQuote - openInterestBase,
    premium_bps: toNumber(sample.premium_bps),
    funding_rate: toNumber(sample.funding_rate),
    sample_type: sample.sample_type || null,
  };
}

function buildRows1s(data, startMs, seconds, openInterestBase) {
  const priceByS = bySecond(data.priceSeries, "scheduled_at", startMs);
  const chainlinkByS = bySecond(data.chainlinkPriceSeries, "scheduled_at", startMs);
  const probabilitiesByS = bySecond(data.polymarketProbabilitySeries, "scheduled_at", startMs);
  const flowByS = bySecond(data.tradeFlow1s, "bucket_start", startMs);
  const microByS = bySecond(data.micropriceBuckets, "bucket_start", startMs);
  const featureByS = bySecond(data.buckets, "bucket_start", startMs);
  const wsByS = bySecond(data.webSocketSummaries, "bucket_start", startMs);
  const positionByS = bySecond(data.positionSeries, "scheduled_at", startMs);

  const rows = [];
  for (let second = 0; second < seconds; second += 1) {
    const price = priceByS.get(second);
    const chainlink = chainlinkByS.get(second);
    const probability = probabilitiesByS.get(second);
    const flow = flowByS.get(second);
    const micro = microByS.get(second);
    const feature = featureByS.get(second);
    const ws = wsByS.get(second);
    const position = positionByS.get(second);
    const openInterestQuote = toNumber(position?.open_interest_quote);
    const midPrice =
      toNumber(flow?.mid_price) ??
      toNumber(micro?.mid_price) ??
      toNumber(ws?.mid_price_close);
    const binancePrice = toNumber(price?.price);

    rows.push({
      s: second,
      ts_utc: toIso(new Date(startMs + second * 1000)),
      price: midPrice ?? binancePrice,
      mid_price: midPrice,
      binance_futures_price: binancePrice,
      chainlink_btc_price: toNumber(chainlink?.price),
      polymarket_up_probability: toNumber(probability?.up_probability),
      polymarket_down_probability: toNumber(probability?.down_probability),
      taker_buy_quote: toNumber(flow?.taker_buy_quote),
      taker_sell_quote: toNumber(flow?.taker_sell_quote),
      net_taker_quote: toNumber(flow?.net_taker_quote),
      gross_taker_quote: toNumber(flow?.gross_taker_quote),
      cvd_market_quote: toNumber(flow?.cvd_market_quote),
      rolling_net_30s: toNumber(flow?.rolling_net_30s),
      rolling_gross_30s: toNumber(flow?.rolling_gross_30s),
      rolling_imbalance_30s: toNumber(flow?.rolling_imbalance_30s),
      trade_count: toInteger(flow?.trade_count),
      microprice_lean: toNumber(micro?.microprice_lean),
      microprice_ewma_3s: toNumber(micro?.ewma_lean_3s),
      microprice_avg_10s: toNumber(micro?.avg_lean_10s),
      microprice_pressure_market: toNumber(micro?.microprice_pressure_market),
      microprice_persistence_signal: micro?.persistence_signal || null,
      microprice_behavior: micro?.microprice_behavior || null,
      book_imbalance_5bps: toNumber(feature?.book_imbalance_5bps),
      spread_bps: toNumber(feature?.spread_bps),
      websocket_spread_avg_bps: toNumber(ws?.spread_bps_avg),
      websocket_spread_max_bps: toNumber(ws?.spread_bps_max),
      websocket_book_updates: toInteger(ws?.book_ticker_update_count),
      liquidation_net_quote: toNumber(ws?.liquidation_net_quote),
      liquidation_count: toInteger(ws?.liquidation_count),
      liquidation_max_quote: toNumber(ws?.liquidation_max_quote),
      open_interest_quote: openInterestQuote,
      open_interest_change_quote:
        openInterestQuote === null || openInterestBase === null
          ? null
          : openInterestQuote - openInterestBase,
      premium_bps: toNumber(position?.premium_bps),
      qualities: {
        flow: flow?.bucket_quality || null,
        microprice: micro?.bucket_quality || null,
        feature_bucket: feature?.bucket_quality || null,
        websocket: ws?.summary_quality || null,
        probability: probability?.quality || null,
        chainlink: chainlink?.quality || null,
      },
    });
  }

  for (const row of rows) {
    for (const windowSeconds of RETURN_WINDOWS_SECONDS) {
      const prior = rows[row.s - windowSeconds];
      row[`ret_${windowSeconds}s_bps`] = returnBps(row.price, prior?.price ?? null);
    }
  }

  return rows;
}

function firstFinite(rows, field) {
  for (const row of rows || []) {
    const value = toNumber(row[field]);
    if (value !== null) return value;
  }
  return null;
}

function buildMarketSummary(data) {
  const feature = data.features?.[0] || null;
  const behavior = data.behaviorLabels?.[0] || null;
  const classification = data.classifications?.[0] || null;
  const positionFeature = data.positionFeatures?.[0] || null;

  return {
    binance_futures_open: toNumber(data.market.binance_futures_open_price),
    binance_futures_close: toNumber(data.market.binance_futures_close_price),
    binance_futures_return_pct: toNumber(data.market.binance_futures_return_pct),
    binance_futures_return_bps:
      toNumber(data.market.binance_futures_return_pct) === null
        ? null
        : toNumber(data.market.binance_futures_return_pct) * 100,
    binance_futures_direction: data.market.binance_futures_direction || null,
    binance_futures_quality: data.market.binance_futures_quality || null,
    chainlink_open: toNumber(data.market.polymarket_open_price),
    chainlink_close: toNumber(data.market.polymarket_close_price),
    chainlink_return_pct: toNumber(data.market.polymarket_return_pct),
    polymarket_winning_outcome: data.market.polymarket_winning_outcome || null,
    range_bps: toNumber(behavior?.range_bps),
    high_price: toNumber(behavior?.high_price),
    high_time_utc: toIso(behavior?.high_time),
    low_price: toNumber(behavior?.low_price),
    low_time_utc: toIso(behavior?.low_time),
    realized_vol_bps: toNumber(behavior?.realized_vol_bps),
    largest_1s_return_bps: toNumber(behavior?.largest_1s_return_bps),
    largest_5s_return_bps: toNumber(behavior?.largest_5s_return_bps),
    total_volume_quote: toNumber(feature?.total_volume_quote),
    net_taker_quote: toNumber(feature?.net_taker_quote),
    taker_imbalance: toNumber(feature?.taker_imbalance),
    avg_book_imbalance_5bps: toNumber(feature?.avg_book_imbalance_5bps),
    avg_spread_bps: toNumber(feature?.avg_spread_bps),
    open_interest_change_quote: toNumber(positionFeature?.open_interest_change_quote),
    open_interest_change_pct: toNumber(positionFeature?.open_interest_change_pct),
    mark_index_basis_change_bps: toNumber(positionFeature?.premium_bps_change),
    market_class: classification?.primary_class || null,
    classification_confidence: toNumber(classification?.confidence),
  };
}

function buildSeries(data, startMs, openInterestBase) {
  const binanceFuturesPrice = data.priceSeries.map((sample) => compactPriceSample(sample, startMs));
  const chainlinkBtcSamples = data.chainlinkPriceSeries.map((sample) =>
    compactChainlinkSample(sample, startMs)
  );

  return {
    binance_futures_price: binanceFuturesPrice,
    chainlink_btc_samples: chainlinkBtcSamples,
    polymarket_probabilities: data.polymarketProbabilitySeries.map((sample) =>
      compactProbabilitySample(sample, startMs)
    ),
    feature_buckets: data.buckets.map((bucket) => compactFeatureBucket(bucket, startMs)),
    positioning: data.positionSeries.map((sample) =>
      compactPositionSample(sample, startMs, openInterestBase)
    ),
  };
}

export async function getMarketLlmExport(marketId) {
  const data = await getMarketDetailData(marketId);
  if (!data.ok) {
    return {
      ok: false,
      status: data.configured ? 500 : 503,
      error: data.error || "Unable to build market export.",
    };
  }

  if (!data.market) {
    return { ok: false, status: 404, error: "Market not found." };
  }

  const startMs = new Date(data.market.start_time).getTime();
  const seconds = marketSeconds(data.market);
  const openInterestBase = firstFinite(data.positionSeries, "open_interest_quote");
  const rows1s = buildRows1s(data, startMs, seconds, openInterestBase);

  return {
    ok: true,
    packet: {
      schema_version: SCHEMA_VERSION,
      generated_at_utc: toIso(new Date()),
      notes: {
        s: "Seconds from market start. The 5 minute market normally has rows s=0 through s=299.",
        price: "Uses 1s Binance Futures mid price when available, otherwise the exact Binance Futures sampled price at that second.",
        raw_trades: "Raw aggregate trades are intentionally omitted. Use market_trade_flow_1s-derived fields for LLM analysis.",
      },
      market: {
        id: data.market.id,
        symbol: data.market.symbol,
        venue: "binance_futures",
        start_utc: toIso(data.market.start_time),
        end_utc: toIso(data.market.end_time),
        status: data.market.status,
        polymarket_slug: data.market.polymarket_slug || null,
      },
      summary: buildMarketSummary(data),
      counts: {
        rows_1s: rows1s.length,
        binance_futures_price_samples: data.priceSeries.length,
        chainlink_btc_samples: data.chainlinkPriceSeries.length,
        polymarket_probability_samples: data.polymarketProbabilitySeries.length,
        trade_flow_1s_rows: data.tradeFlow1s.length,
        microprice_1s_rows: data.micropriceBuckets.length,
        feature_buckets: data.buckets.length,
        websocket_1s_summaries: data.webSocketSummaries.length,
        positioning_samples: data.positionSeries.length,
      },
      rows_1s: rows1s,
      series: buildSeries(data, startMs, openInterestBase),
    },
  };
}

export function marketPacketFilename(marketId) {
  const safeId = String(marketId || "market").replace(/[^A-Za-z0-9._-]+/g, "-");
  return `market_packet_${safeId}.json`;
}
