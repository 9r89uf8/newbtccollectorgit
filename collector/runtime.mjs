import { closePool } from "../lib/db.js";
import {
  COLLECTOR_NAME,
  ENABLE_POLYMARKET_CHAINLINK_BTC_PRICE,
  ENABLE_FUTURES_MICROSTRUCTURE,
  ENABLE_FUTURES_POSITIONING,
  ENABLE_FUTURES_WEBSOCKET_SUMMARIES,
  ENABLE_POLYMARKET_BTC_5M,
  EXPECTED_POLYMARKET_PROBABILITY_SAMPLES_PER_MARKET,
  POLYMARKET_5M_BTC_SOURCE,
  POLYMARKET_METADATA_PREFETCH_LEAD_MS,
  SYMBOL,
} from "./config.mjs";
import { collectFuturesAggregateTradesForMarket } from "./aggTrades.mjs";
import { collectFuturesBookSample } from "./bookSamples.mjs";
import {
  collectPolymarketChainlinkBtcPriceSample,
  collectPolymarketChainlinkBtcPriceSamples,
  startPolymarketChainlinkBtcPriceCollector,
} from "./chainlinkBtcSamples.mjs";
import {
  collectFuturesPositionSample,
  shouldCollectFuturesPositionSample,
} from "./derivativePositionSamples.mjs";
import {
  refreshRecentForwardLabels,
  writeMarketForwardLabels,
} from "./forwardLabels.mjs";
import { collectFuturesBasisSamplesForMarket } from "./futuresBasisSamples.mjs";
import { startFuturesWebSocketSummaryCollector } from "./futuresWebSocketSummaries.mjs";
import { writeMarketBehaviorLabel } from "./marketBehaviorLabels.mjs";
import { writeMarketClassification } from "./marketClassifications.mjs";
import { writeMarketCvdBuckets } from "./marketCvdBuckets.mjs";
import {
  refreshRecentMicropriceBuckets,
  writeMarketMicropriceBuckets,
} from "./marketMicropriceBuckets.mjs";
import { writeMarketFeatureBuckets } from "./marketFeatureBuckets.mjs";
import { writeMarketFeatures } from "./marketFeatures.mjs";
import { writeMarketLabels } from "./marketLabels.mjs";
import { writeMarketTradeFlow1s } from "./marketTradeFlow1s.mjs";
import { writeMarketPositionFeatures } from "./marketPositionFeatures.mjs";
import {
  collectPolymarketProbabilitySample,
  getPolymarketProbabilitySampleStats,
  prefetchPolymarketMarketMetadata,
  refreshPolymarketMarketMetadata,
  refreshRecentPolymarketSettlements,
} from "./polymarketSamples.mjs";
import { collectPriceSamples } from "./priceSamples.mjs";
import {
  getMarketWindow,
  getNextScheduledMs,
  getSampleType,
  sleep,
  toIsoSeconds,
} from "./time.mjs";
import {
  getDueOpenMarkets,
  getMarketStatus,
  heartbeat,
  markMarketIncomplete,
  recordError,
  updateMarketStatus,
  upsertMarket,
} from "./store.mjs";

let stopping = false;
let futuresWebSocketCollector = null;
let polymarketChainlinkBtcPriceCollector = null;
const pendingMarketClosures = new Map();

async function markStartupMarketIncompleteIfNeeded(market, nowMs = Date.now()) {
  const nextScheduledMs = getNextScheduledMs(nowMs, market);
  if (nextScheduledMs <= market.startMs) return;

  const changed = await markMarketIncomplete(market.id);
  if (!changed) return;

  const message = `collector started/restarted at ${toIsoSeconds(
    new Date(nowMs)
  )} after ${market.id} began; marking market incomplete`;

  await recordError({
    marketId: market.id,
    source: COLLECTOR_NAME,
    errorType: "collector_restart_gap",
    message,
  });
  await heartbeat(COLLECTOR_NAME, "error", market.id, message);
}

async function recordPolymarketRuntimeError(marketId, errorType, error, source) {
  await recordError({
    marketId,
    source,
    errorType: error.name === "AbortError" ? "timeout" : errorType,
    message: error.message || String(error),
  });
}

function getNextMarketAfter(market) {
  return getMarketWindow(new Date(market.endMs));
}

async function prefetchUpcomingPolymarketMetadata(market, nowMs = Date.now()) {
  if (!ENABLE_POLYMARKET_BTC_5M) return;

  const targets = [market];
  const nextMarket = getNextMarketAfter(market);
  if (nextMarket.startMs - nowMs <= POLYMARKET_METADATA_PREFETCH_LEAD_MS) {
    targets.push(nextMarket);
  }

  await Promise.allSettled(
    targets.map((target) => prefetchPolymarketMarketMetadata(target, nowMs))
  );
}

async function collectNextMarketOpeningPolymarketSample(market, scheduledAt) {
  if (!ENABLE_POLYMARKET_BTC_5M || scheduledAt.getTime() !== market.endMs) {
    return { ok: true, source: POLYMARKET_5M_BTC_SOURCE.probabilitySource, skipped: true };
  }

  const nextMarket = getNextMarketAfter(market);
  await upsertMarket(nextMarket);
  await prefetchPolymarketMarketMetadata(nextMarket, scheduledAt.getTime());
  return collectPolymarketProbabilitySample(nextMarket, scheduledAt, "normal");
}

async function collectScheduledPolymarketChainlinkBtcPriceSamples(market, scheduledAt, sampleType) {
  if (sampleType !== "close" || scheduledAt.getTime() !== market.endMs) {
    return collectPolymarketChainlinkBtcPriceSample(market, scheduledAt, sampleType);
  }

  const nextMarket = getNextMarketAfter(market);
  await upsertMarket(nextMarket);
  return collectPolymarketChainlinkBtcPriceSamples(
    [
      { market, sampleType: "close" },
      { market: nextMarket, sampleType: "normal" },
    ],
    scheduledAt
  );
}

function scheduleMarketClose(market) {
  const existing = pendingMarketClosures.get(market.id);
  if (existing) return existing;

  const closePromise = closeMarket(market)
    .catch(async (error) => {
      await recordError({
        marketId: market.id,
        source: COLLECTOR_NAME,
        errorType: "market_close_error",
        message: error.message || String(error),
      });
      await heartbeat(COLLECTOR_NAME, "error", market.id, error.message || String(error));
    })
    .finally(() => {
      pendingMarketClosures.delete(market.id);
    });

  pendingMarketClosures.set(market.id, closePromise);
  return closePromise;
}

async function waitForPendingMarketClosures() {
  if (pendingMarketClosures.size === 0) return;
  await Promise.allSettled([...pendingMarketClosures.values()]);
}

async function collectScheduledData(market, scheduledAt, sampleType) {
  const tasks = [collectPriceSamples(market, scheduledAt, sampleType)];

  if (ENABLE_POLYMARKET_BTC_5M) {
    tasks.push(collectPolymarketProbabilitySample(market, scheduledAt, sampleType));
    if (sampleType === "close") {
      tasks.push(collectNextMarketOpeningPolymarketSample(market, scheduledAt));
    }
  }

  if (ENABLE_POLYMARKET_CHAINLINK_BTC_PRICE) {
    tasks.push(collectScheduledPolymarketChainlinkBtcPriceSamples(market, scheduledAt, sampleType));
  }

  if (ENABLE_FUTURES_MICROSTRUCTURE) {
    tasks.push(collectFuturesBookSample(market, scheduledAt, sampleType));

    if (
      ENABLE_FUTURES_POSITIONING &&
      shouldCollectFuturesPositionSample(market, scheduledAt)
    ) {
      tasks.push(collectFuturesPositionSample(market, scheduledAt, sampleType));
    }
  }

  const results = await Promise.all(tasks);
  const failures = results.flatMap((result) => {
    if (Array.isArray(result.results)) {
      return result.results.filter((item) => !item.ok);
    }
    return result.ok ? [] : [result];
  });

  const message =
    failures.length > 0
      ? `${failures.length} collection task(s) failed at ${toIsoSeconds(scheduledAt)}`
      : `sampled ${sampleType} at ${toIsoSeconds(scheduledAt)}`;

  await heartbeat(COLLECTOR_NAME, failures.length > 0 ? "error" : "running", market.id, message);
}

export async function closeMarket(market) {
  let aggTradeResult = null;
  let featureResult = null;
  let bucketResult = null;
  let cvdBucketResult = null;
  let tradeFlowResult = null;
  let micropriceBucketResult = null;
  let positionResult = null;
  let basisResult = null;
  let behaviorResult = null;
  let classificationResult = null;
  let forwardResult = null;
  let forwardRefreshResult = null;
  let micropriceRefreshResult = null;
  let polymarketStats = null;
  let polymarketRefreshResult = null;

  if (ENABLE_FUTURES_MICROSTRUCTURE) {
    aggTradeResult = await collectFuturesAggregateTradesForMarket(market);
    if (ENABLE_FUTURES_POSITIONING) {
      basisResult = await collectFuturesBasisSamplesForMarket(market);
    }
  }

  const labels = await writeMarketLabels(market);

  if (ENABLE_POLYMARKET_BTC_5M) {
    try {
      await refreshPolymarketMarketMetadata(market);
    } catch (error) {
      await recordPolymarketRuntimeError(
        market.id,
        "polymarket_metadata_refresh_error",
        error,
        POLYMARKET_5M_BTC_SOURCE.marketSource
      );
    }

    try {
      polymarketStats = await getPolymarketProbabilitySampleStats(market);
    } catch (error) {
      await recordPolymarketRuntimeError(
        market.id,
        "polymarket_probability_stats_error",
        error,
        POLYMARKET_5M_BTC_SOURCE.probabilitySource
      );
    }
  }

  if (ENABLE_FUTURES_MICROSTRUCTURE) {
    featureResult = await writeMarketFeatures(market);
    bucketResult = await writeMarketFeatureBuckets(market);
    cvdBucketResult = await writeMarketCvdBuckets(market);
    if (ENABLE_FUTURES_WEBSOCKET_SUMMARIES) {
      micropriceBucketResult = await writeMarketMicropriceBuckets(market);
    }
    tradeFlowResult = await writeMarketTradeFlow1s(market, {
      bucketQuality: aggTradeResult?.ok && !aggTradeResult?.truncated ? "complete" : "partial",
    });
    behaviorResult = await writeMarketBehaviorLabel(market);
    if (ENABLE_FUTURES_POSITIONING) {
      positionResult = await writeMarketPositionFeatures(market);
    }
    classificationResult = await writeMarketClassification(market);

    if (ENABLE_FUTURES_WEBSOCKET_SUMMARIES) {
      forwardResult = await writeMarketForwardLabels(market);
    }
  }

  const wasMarkedIncomplete = (await getMarketStatus(market.id)) === "incomplete";
  const complete = labels.every((label) => label.quality === "complete");
  const status = complete && !wasMarkedIncomplete ? "closed" : "incomplete";
  const featureMessage = featureResult
    ? `; features ${featureResult.feature_quality}`
    : "";
  const bucketMessage = bucketResult
    ? `; buckets ${bucketResult.bucketCount}`
    : "";
  const cvdBucketMessage = cvdBucketResult
    ? `; cvd ${cvdBucketResult.cvdBucketCount}`
    : "";
  const tradeFlowMessage = tradeFlowResult
    ? `; trade flow 1s ${tradeFlowResult.tradeFlowBucketCount} ${tradeFlowResult.bucketQuality}`
    : "";
  const micropriceBucketMessage = micropriceBucketResult
    ? `; microprice ${micropriceBucketResult.micropriceBucketCount}`
    : "";
  const positionMessage = positionResult ? `; positioning ${positionResult.position_quality}` : "";
  const basisMessage = basisResult
    ? `; basis ${basisResult.ok ? basisResult.sampleCount : "error"}`
    : "";
  const behaviorMessage = behaviorResult ? `; behavior ${behaviorResult.shape_class}` : "";
  const classificationMessage = classificationResult ? `; class ${classificationResult.primary_class}` : "";
  const forwardMessage = forwardResult ? `; forward labels ${forwardResult.labelCount}` : "";
  const polymarketMessage = polymarketStats
    ? `; polymarket ${polymarketStats.sample_count}/${EXPECTED_POLYMARKET_PROBABILITY_SAMPLES_PER_MARKET} samples, ${polymarketStats.complete_count} complete`
    : "";

  await updateMarketStatus(market.id, status);

  if (ENABLE_FUTURES_MICROSTRUCTURE && ENABLE_FUTURES_WEBSOCKET_SUMMARIES) {
    micropriceRefreshResult = await refreshRecentMicropriceBuckets();
    forwardRefreshResult = await refreshRecentForwardLabels();
  }

  if (ENABLE_POLYMARKET_BTC_5M) {
    try {
      polymarketRefreshResult = await refreshRecentPolymarketSettlements();
    } catch (error) {
      await recordPolymarketRuntimeError(
        market.id,
        "polymarket_settlement_refresh_error",
        error,
        POLYMARKET_5M_BTC_SOURCE.marketSource
      );
    }
  }

  const micropriceRefreshMessage = micropriceRefreshResult?.micropriceBucketCount
    ? `; refreshed microprice ${micropriceRefreshResult.micropriceBucketCount}`
    : "";
  const forwardRefreshMessage = forwardRefreshResult?.labelCount
    ? `; refreshed forward labels ${forwardRefreshResult.labelCount}`
    : "";
  const polymarketRefreshMessage = polymarketRefreshResult?.refreshedCount
    ? `; polymarket metadata refreshed ${polymarketRefreshResult.refreshedCount}`
    : "";
  const incompleteMarkerMessage = wasMarkedIncomplete ? "; premarked incomplete" : "";

  await heartbeat(
    COLLECTOR_NAME,
    "running",
    market.id,
    `closed ${market.id} as ${status}${featureMessage}${bucketMessage}${cvdBucketMessage}${tradeFlowMessage}${micropriceBucketMessage}${positionMessage}${basisMessage}${behaviorMessage}${classificationMessage}${forwardMessage}${polymarketMessage}${micropriceRefreshMessage}${forwardRefreshMessage}${polymarketRefreshMessage}${incompleteMarkerMessage}`
  );
}

async function closeDueMarkets({ waitForClose = true } = {}) {
  const markets = await getDueOpenMarkets();
  const closePromises = markets.map((market) => scheduleMarketClose(market));
  if (waitForClose) {
    await Promise.allSettled(closePromises);
  }
}

export async function runCollector() {
  console.log(`${COLLECTOR_NAME} starting for ${SYMBOL}`);
  await heartbeat(COLLECTOR_NAME, "running", null, "collector starting");

  if (
    ENABLE_FUTURES_MICROSTRUCTURE &&
    ENABLE_FUTURES_WEBSOCKET_SUMMARIES &&
    !futuresWebSocketCollector
  ) {
    futuresWebSocketCollector = startFuturesWebSocketSummaryCollector();
  }

  if (ENABLE_POLYMARKET_CHAINLINK_BTC_PRICE && !polymarketChainlinkBtcPriceCollector) {
    polymarketChainlinkBtcPriceCollector = startPolymarketChainlinkBtcPriceCollector();
  }

  await closeDueMarkets();
  if (ENABLE_POLYMARKET_BTC_5M) {
    try {
      await refreshRecentPolymarketSettlements();
    } catch (error) {
      await recordPolymarketRuntimeError(
        null,
        "polymarket_settlement_refresh_error",
        error,
        POLYMARKET_5M_BTC_SOURCE.marketSource
      );
    }
  }

  const startupMarket = getMarketWindow();
  await upsertMarket(startupMarket);
  await markStartupMarketIncompleteIfNeeded(startupMarket);

  while (!stopping) {
    const market = getMarketWindow();
    await upsertMarket(market);

    const scheduledMs = getNextScheduledMs(Date.now(), market);
    const prefetchWaitMs = Math.max(0, scheduledMs - Date.now());
    if (prefetchWaitMs > 1500) {
      await prefetchUpcomingPolymarketMetadata(market, Date.now());
    }

    const waitMs = Math.max(0, scheduledMs - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    if (stopping) break;

    const scheduledAt = new Date(scheduledMs);
    const sampleType = getSampleType(scheduledMs, market);

    await collectScheduledData(market, scheduledAt, sampleType);

    if (scheduledMs >= market.endMs) {
      scheduleMarketClose(market);
      await closeDueMarkets({ waitForClose: false });
    }
  }
}

export async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`received ${signal}, stopping collector`);
  try {
    if (futuresWebSocketCollector) {
      await futuresWebSocketCollector.stop();
      futuresWebSocketCollector = null;
    }
    if (polymarketChainlinkBtcPriceCollector) {
      await polymarketChainlinkBtcPriceCollector.stop();
      polymarketChainlinkBtcPriceCollector = null;
    }
    await heartbeat(COLLECTOR_NAME, "stopped", null, `stopped by ${signal}`);
  } finally {
    await waitForPendingMarketClosures();
    await closePool();
  }
}
