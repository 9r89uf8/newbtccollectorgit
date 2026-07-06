import {
  ENABLE_FUTURES_MICROSTRUCTURE,
  ENABLE_FUTURES_POSITIONING,
  ENABLE_LIVE_DASHBOARD,
  FUTURES_MICROSTRUCTURE_SOURCE,
  POSITION_SAMPLE_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
} from "./config.mjs";
import { fetchJson } from "./http.mjs";
import { observeFuturesPositionTick } from "./liveState.mjs";
import { recordError } from "./store.mjs";

function readNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readPositiveNumber(value, fieldName) {
  const number = readNumber(value);
  if (number === null || number <= 0) {
    throw new Error(`Invalid ${fieldName} in live positioning payload`);
  }
  return number;
}

function readNonNegativeNumber(value, fieldName) {
  const number = readNumber(value);
  if (number === null || number < 0) {
    throw new Error(`Invalid ${fieldName} in live positioning payload`);
  }
  return number;
}

function readTimestampMs(value) {
  const number = readNumber(value);
  return number !== null && number > 0 ? number : null;
}

function parsePositionTick(markData, openInterestData, latencyMs) {
  const markPrice = readPositiveNumber(markData?.markPrice, "markPrice");
  const indexPrice = readPositiveNumber(markData?.indexPrice, "indexPrice");
  const openInterestBase = readNonNegativeNumber(openInterestData?.openInterest, "openInterest");

  return {
    markPrice,
    indexPrice,
    premiumBps: ((markPrice - indexPrice) / indexPrice) * 10000,
    fundingRate: readNumber(markData?.lastFundingRate),
    nextFundingTime: readTimestampMs(markData?.nextFundingTime),
    openInterestBase,
    openInterestQuote: openInterestBase * markPrice,
    markExchangeTs: readTimestampMs(markData?.time),
    openInterestExchangeTs: readTimestampMs(openInterestData?.time),
    receivedTs: Date.now(),
    latencyMs,
  };
}

async function collectLivePositioningTick() {
  const source = FUTURES_MICROSTRUCTURE_SOURCE;
  const [markResult, openInterestResult] = await Promise.all([
    fetchJson(source.markPriceUrl(), REQUEST_TIMEOUT_MS),
    fetchJson(source.openInterestUrl(), REQUEST_TIMEOUT_MS),
  ]);
  const latencyMs = Math.max(markResult.latencyMs, openInterestResult.latencyMs);
  observeFuturesPositionTick(parsePositionTick(markResult.data, openInterestResult.data, latencyMs));
}

export function startLivePositioningCollector() {
  if (!ENABLE_LIVE_DASHBOARD || !ENABLE_FUTURES_MICROSTRUCTURE || !ENABLE_FUTURES_POSITIONING) {
    return { stop() {} };
  }

  let stopped = false;
  let inFlight = false;
  let timer = null;

  async function collect() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await collectLivePositioningTick();
    } catch (error) {
      await recordError({
        marketId: null,
        source: FUTURES_MICROSTRUCTURE_SOURCE.source,
        errorType: error.name === "AbortError" ? "live_position_timeout" : "live_position_fetch_error",
        message: error.message || String(error),
      });
    } finally {
      inFlight = false;
    }
  }

  collect().catch(() => {});
  timer = setInterval(() => {
    collect().catch(() => {});
  }, POSITION_SAMPLE_INTERVAL_MS);
  timer.unref?.();

  return {
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}