import { closePool } from "../lib/db.js";
import {
  COLLECTOR_NAME,
  ENABLE_FUTURES_MICROSTRUCTURE,
  SYMBOL,
} from "./config.mjs";
import { collectFuturesAggregateTradesForMarket } from "./aggTrades.mjs";
import { collectFuturesBookSample } from "./bookSamples.mjs";
import { writeMarketFeatures } from "./marketFeatures.mjs";
import { writeMarketLabels } from "./marketLabels.mjs";
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
  heartbeat,
  updateMarketStatus,
  upsertMarket,
} from "./store.mjs";

let stopping = false;

async function collectScheduledData(market, scheduledAt, sampleType) {
  const tasks = [collectPriceSamples(market, scheduledAt, sampleType)];

  if (ENABLE_FUTURES_MICROSTRUCTURE) {
    tasks.push(collectFuturesBookSample(market, scheduledAt, sampleType));
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
  let featureResult = null;

  if (ENABLE_FUTURES_MICROSTRUCTURE) {
    await collectFuturesAggregateTradesForMarket(market);
  }

  const labels = await writeMarketLabels(market);

  if (ENABLE_FUTURES_MICROSTRUCTURE) {
    featureResult = await writeMarketFeatures(market);
  }

  const complete = labels.every((label) => label.quality === "complete");
  const status = complete ? "closed" : "incomplete";
  const featureMessage = featureResult
    ? `; features ${featureResult.feature_quality}`
    : "";

  await updateMarketStatus(market.id, status);
  await heartbeat(COLLECTOR_NAME, "running", market.id, `closed ${market.id} as ${status}${featureMessage}`);
}

async function closeDueMarkets() {
  const markets = await getDueOpenMarkets();
  for (const market of markets) {
    await closeMarket(market);
  }
}

export async function runCollector() {
  console.log(`${COLLECTOR_NAME} starting for ${SYMBOL}`);
  await heartbeat(COLLECTOR_NAME, "running", null, "collector starting");
  await closeDueMarkets();

  while (!stopping) {
    const market = getMarketWindow();
    await upsertMarket(market);

    const scheduledMs = getNextScheduledMs(Date.now(), market);
    const waitMs = Math.max(0, scheduledMs - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    if (stopping) break;

    const scheduledAt = new Date(scheduledMs);
    const sampleType = getSampleType(scheduledMs, market);

    await collectScheduledData(market, scheduledAt, sampleType);

    if (scheduledMs >= market.endMs) {
      await closeMarket(market);
      await closeDueMarkets();
    }
  }
}

export async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`received ${signal}, stopping collector`);
  try {
    await heartbeat(COLLECTOR_NAME, "stopped", null, `stopped by ${signal}`);
  } finally {
    await closePool();
  }
}
