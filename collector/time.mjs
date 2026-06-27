import {
  FINAL_RAMP_INTERVAL_MS,
  FINAL_RAMP_START_MS,
  MARKET_CLOSE_MS,
  MARKET_MS,
  NORMAL_INTERVAL_MS,
  SYMBOL,
} from "./config.mjs";

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toIsoSeconds(date) {
  return date.toISOString().replace(".000Z", "Z");
}

export function getMarketWindow(date = new Date(), symbol = SYMBOL) {
  const startMs = Math.floor(date.getTime() / MARKET_MS) * MARKET_MS;
  const endMs = startMs + MARKET_MS;
  const start = new Date(startMs);
  const end = new Date(endMs);

  return {
    id: `${toIsoSeconds(start)}_${symbol}`,
    symbol,
    start,
    end,
    startMs,
    endMs,
  };
}

export function getSampleType(scheduledMs, market) {
  const offset = scheduledMs - market.startMs;
  if (offset >= MARKET_CLOSE_MS) return "close";
  if (offset >= FINAL_RAMP_START_MS) return "final_ramp";
  return "normal";
}

export function getNextScheduledMs(nowMs, market) {
  const elapsed = Math.max(0, nowMs - market.startMs);

  if (elapsed <= 275000) {
    return market.startMs + Math.ceil(elapsed / NORMAL_INTERVAL_MS) * NORMAL_INTERVAL_MS;
  }

  if (elapsed <= FINAL_RAMP_START_MS) {
    return market.startMs + FINAL_RAMP_START_MS;
  }

  if (elapsed <= MARKET_CLOSE_MS) {
    return (
      market.startMs +
      Math.ceil(elapsed / FINAL_RAMP_INTERVAL_MS) * FINAL_RAMP_INTERVAL_MS
    );
  }

  return market.endMs;
}
