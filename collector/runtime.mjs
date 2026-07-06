//collector/runtime.mjs
import { closePool, query } from "../lib/db.js";
import {
  COLLECTOR_NAME,
  PRICE_SOURCES,
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
import { startLiveDashboardServer } from "./liveServer.mjs";
import { startLivePositioningCollector } from "./livePositioning.mjs";
import { startLiveStateFlusher } from "./liveState.mjs";
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
import { startPolymarketClobLiveCollector } from "./polymarketClobLive.mjs";
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
let polymarketClobLiveCollector = null;
let liveStateFlusher = null;
let liveDashboardServer = null;
let livePositioningCollector = null;
const ensuredBoundaryCloseStarts = new Set();
const BOUNDARY_CLOSE_GRACE_MS = 15000;
const pendingMarketClosures = new Map();
const pendingPolymarketOpeningRetries = new Map();
const POLYMARKET_OPENING_RETRY_MS = 1000;
const POLYMARKET_OPENING_RETRY_WINDOW_MS = 20000;

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

function isCompletePolymarketOpening(result) {
  return result?.ok && result.quality === "complete";
}

function shouldRetryPolymarketOpening(result) {
  return ENABLE_POLYMARKET_BTC_5M && !isCompletePolymarketOpening(result);
}

async function getPolymarketOpeningSample(market, scheduledAt) {
  const result = await query(
    `
      select quality, availability_status, data_delay_ms
      from polymarket_probability_samples
      where source = $1
        and market_id = $2
        and scheduled_at = $3
      limit 1
    `,
    [POLYMARKET_5M_BTC_SOURCE.probabilitySource, market.id, scheduledAt]
  );

  return result.rows[0] || null;
}

async function collectOpeningPolymarketSampleIfNeeded(market, scheduledAt) {
  if (!ENABLE_POLYMARKET_BTC_5M) {
    return { ok: true, source: POLYMARKET_5M_BTC_SOURCE.probabilitySource, skipped: true };
  }

  const existing = await getPolymarketOpeningSample(market, scheduledAt);
  if (existing?.quality === "complete") {
    return {
      ok: true,
      source: POLYMARKET_5M_BTC_SOURCE.probabilitySource,
      skipped: true,
      quality: "complete",
      availabilityStatus: existing.availability_status,
      dataDelayMs: existing.data_delay_ms,
    };
  }

  await prefetchPolymarketMarketMetadata(market, scheduledAt.getTime());
  return collectPolymarketProbabilitySample(market, scheduledAt, "normal");
}

function schedulePolymarketOpeningRetry(market, scheduledAt) {
  if (!ENABLE_POLYMARKET_BTC_5M || scheduledAt.getTime() !== market.startMs) return;

  const key = `${market.id}:${scheduledAt.getTime()}`;
  if (pendingPolymarketOpeningRetries.has(key)) return;

  const promise = (async () => {
    const deadlineMs = scheduledAt.getTime() + POLYMARKET_OPENING_RETRY_WINDOW_MS;

    while (!stopping && Date.now() < deadlineMs) {
      const sleepMs = Math.min(POLYMARKET_OPENING_RETRY_MS, Math.max(0, deadlineMs - Date.now()));
      if (sleepMs > 0) await sleep(sleepMs);
      if (stopping || Date.now() > deadlineMs) break;

      const result = await collectOpeningPolymarketSampleIfNeeded(market, scheduledAt);
      if (isCompletePolymarketOpening(result)) return;
    }
  })()
    .catch(async (error) => {
      await recordError({
        marketId: market.id,
        source: POLYMARKET_5M_BTC_SOURCE.probabilitySource,
        errorType: "polymarket_opening_retry_error",
        message: error.message || String(error),
      });
    })
    .finally(() => {
      pendingPolymarketOpeningRetries.delete(key);
    });

  pendingPolymarketOpeningRetries.set(key, promise);
}

async function waitForPendingPolymarketOpeningRetries() {
  if (pendingPolymarketOpeningRetries.size === 0) return;
  await Promise.allSettled([...pendingPolymarketOpeningRetries.values()]);
}

function describePolymarketOpeningResult(result) {
  if (!ENABLE_POLYMARKET_BTC_5M) return "disabled";
  if (result?.skipped && result.quality === "complete") return "already complete";
  if (result?.quality) return result.quality;
  return result?.ok ? "attempted" : "failed";
}

async function collectNextMarketOpeningPolymarketSample(market, scheduledAt) {
  if (!ENABLE_POLYMARKET_BTC_5M || scheduledAt.getTime() !== market.endMs) {
    return { ok: true, source: POLYMARKET_5M_BTC_SOURCE.probabilitySource, skipped: true };
  }

  const nextMarket = getNextMarketAfter(market);
  await upsertMarket(nextMarket);
  await prefetchPolymarketMarketMetadata(nextMarket, scheduledAt.getTime());

  const result = await collectPolymarketProbabilitySample(nextMarket, scheduledAt, "normal");
  if (shouldRetryPolymarketOpening(result)) {
    schedulePolymarketOpeningRetry(nextMarket, scheduledAt);
  }
  return result;
}

async function collectUpcomingPolymarketPreopenSample(market, scheduledAt) {
  if (!ENABLE_POLYMARKET_BTC_5M) {
    return { ok: true, source: POLYMARKET_5M_BTC_SOURCE.probabilitySource, skipped: true };
  }

  const nextMarket = getNextMarketAfter(market);
  const leadMs = nextMarket.startMs - scheduledAt.getTime();
  if (leadMs <= 0 || leadMs > POLYMARKET_METADATA_PREFETCH_LEAD_MS) {
    return { ok: true, source: POLYMARKET_5M_BTC_SOURCE.probabilitySource, skipped: true };
  }

  await upsertMarket(nextMarket);
  await prefetchPolymarketMarketMetadata(nextMarket, scheduledAt.getTime());
  return collectPolymarketProbabilitySample(nextMarket, scheduledAt, "preopen");
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

async function countBoundaryClosePriceSources(market, boundaryAt) {
  const result = await query(
    `
      select count(distinct source)::int as source_count
      from price_samples
      where symbol = $1
        and scheduled_at = $2
        and sample_type = 'close'
        and source = any($3::text[])
    `,
    [market.symbol, boundaryAt, PRICE_SOURCES.map((sourceConfig) => sourceConfig.source)]
  );

  return Number(result.rows[0]?.source_count || 0);
}

async function ensurePreviousMarketCloseSample(currentMarket, nowMs = Date.now()) {
  if (ensuredBoundaryCloseStarts.has(currentMarket.startMs)) {
    return { available: true, skipped: true };
  }

  const boundaryLagMs = nowMs - currentMarket.startMs;
  if (boundaryLagMs < 0 || boundaryLagMs > BOUNDARY_CLOSE_GRACE_MS) {
    return { available: false, skipped: true };
  }

  const boundaryAt = new Date(currentMarket.startMs);
  const previousMarket = getMarketWindow(new Date(currentMarket.startMs - 1), currentMarket.symbol);
  const expectedSourceCount = PRICE_SOURCES.length;
  const existingSourceCount = await countBoundaryClosePriceSources(previousMarket, boundaryAt);

  if (existingSourceCount >= expectedSourceCount) {
    ensuredBoundaryCloseStarts.add(currentMarket.startMs);
    scheduleMarketClose(previousMarket);
    await closeDueMarkets({ waitForClose: false });
    return { available: true, skipped: true };
  }

  await upsertMarket(previousMarket);
  await collectScheduledData(previousMarket, boundaryAt, "close");
  scheduleMarketClose(previousMarket);
  await closeDueMarkets({ waitForClose: false });

  const sourceCount = await countBoundaryClosePriceSources(previousMarket, boundaryAt);
  const available = sourceCount >= expectedSourceCount;
  if (available) ensuredBoundaryCloseStarts.add(currentMarket.startMs);
  return { available, collected: true };
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

  if (!liveStateFlusher) {
    liveStateFlusher = startLiveStateFlusher();
  }

  if (!liveDashboardServer) {
    liveDashboardServer = startLiveDashboardServer();
  }

  if (!livePositioningCollector) {
    livePositioningCollector = startLivePositioningCollector();
  }

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

  if (ENABLE_POLYMARKET_BTC_5M && !polymarketClobLiveCollector) {
    polymarketClobLiveCollector = startPolymarketClobLiveCollector();
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
    const previousClose = await ensurePreviousMarketCloseSample(market);
    const prefetchWaitMs = Math.max(0, scheduledMs - Date.now());
    if (prefetchWaitMs > 1500) {
      await prefetchUpcomingPolymarketMetadata(market, Date.now());
    }

    const waitMs = Math.max(0, scheduledMs - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    if (stopping) break;

    const scheduledAt = new Date(scheduledMs);
    const sampleType = getSampleType(scheduledMs, market);

    if (scheduledMs === market.startMs && previousClose.available) {
      const polyResult = await collectOpeningPolymarketSampleIfNeeded(market, scheduledAt);
      if (shouldRetryPolymarketOpening(polyResult)) {
        schedulePolymarketOpeningRetry(market, scheduledAt);
      }

      await heartbeat(
        COLLECTOR_NAME,
        polyResult.ok ? "running" : "error",
        market.id,
        `boundary close available at ${toIsoSeconds(scheduledAt)}; opening polymarket ${describePolymarketOpeningResult(polyResult)}`
      );
      continue;
    }

    await Promise.all([
      collectScheduledData(market, scheduledAt, sampleType),
      collectUpcomingPolymarketPreopenSample(market, scheduledAt),
    ]);
    if (scheduledMs === market.startMs) {
      schedulePolymarketOpeningRetry(market, scheduledAt);
    }

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
    if (polymarketClobLiveCollector) {
      await polymarketClobLiveCollector.stop();
      polymarketClobLiveCollector = null;
    }
    if (liveStateFlusher) {
      await liveStateFlusher.stop();
      liveStateFlusher = null;
    }
    if (liveDashboardServer) {
      await liveDashboardServer.stop();
      liveDashboardServer = null;
    }
    if (livePositioningCollector) {
      await livePositioningCollector.stop();
      livePositioningCollector = null;
    }
    await heartbeat(COLLECTOR_NAME, "stopped", null, `stopped by ${signal}`);
  } finally {
    await waitForPendingPolymarketOpeningRetries();
    await waitForPendingMarketClosures();
    await closePool();
  }
}


