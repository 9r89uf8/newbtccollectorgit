const BINANCE_SPOT_BASE_URL = (process.env.BINANCE_SPOT_BASE_URL || "https://api.binance.com").replace(
  /\/+$/,
  ""
);
const BINANCE_FUTURES_BASE_URL = (
  process.env.BINANCE_FUTURES_BASE_URL || "https://fapi.binance.com"
).replace(/\/+$/, "");
const BINANCE_FUTURES_WS_BASE_URL = (
  process.env.BINANCE_FUTURES_WS_BASE_URL || "wss://fstream.binance.com/stream"
).replace(/\/+$/, "");
const POLYMARKET_GAMMA_BASE_URL = (
  process.env.POLYMARKET_GAMMA_BASE_URL || "https://gamma-api.polymarket.com"
).replace(/\/+$/, "");
const POLYMARKET_CLOB_BASE_URL = (
  process.env.POLYMARKET_CLOB_BASE_URL || "https://clob.polymarket.com"
).replace(/\/+$/, "");

function readPositiveNumber(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function buildUrl(baseUrl, path, params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      search.set(key, String(value));
    }
  }
  return `${baseUrl}${path}?${search.toString()}`;
}

function buildFuturesWebSocketUrl(streams) {
  return `${BINANCE_FUTURES_WS_BASE_URL}?streams=${streams.join("/")}`;
}

export const MARKET_MS = 5 * 60 * 1000;
export const NORMAL_INTERVAL_MS = 5 * 1000;
export const FINAL_RAMP_START_MS = 280 * 1000;
export const FINAL_RAMP_INTERVAL_MS = 1000;
export const MARKET_CLOSE_MS = 300 * 1000;
export const EXPECTED_PRICE_SAMPLES_PER_SOURCE = 77;
export const MIN_COMPLETE_PRICE_LABEL_SAMPLES = EXPECTED_PRICE_SAMPLES_PER_SOURCE - 1;
export const EXPECTED_BOOK_SAMPLES_PER_MARKET = 76;
export const EXPECTED_POLYMARKET_PROBABILITY_SAMPLES_PER_MARKET = 76;

export const COLLECTOR_NAME = process.env.COLLECTOR_NAME || "btc-price-collector";
export const SYMBOL = process.env.COLLECTOR_SYMBOL || "BTCUSDT";
export const REQUEST_TIMEOUT_MS = readPositiveNumber("BINANCE_TIMEOUT_MS", 4000);
export const POLYMARKET_TIMEOUT_MS = readPositiveNumber("POLYMARKET_TIMEOUT_MS", REQUEST_TIMEOUT_MS);
export const POLYMARKET_METADATA_PREFETCH_LEAD_MS = readPositiveNumber(
  "POLYMARKET_METADATA_PREFETCH_LEAD_MS",
  60_000
);
export const ENABLE_FUTURES_MICROSTRUCTURE = readBoolean(
  "ENABLE_FUTURES_MICROSTRUCTURE",
  true
);
export const ENABLE_FUTURES_POSITIONING = readBoolean("ENABLE_FUTURES_POSITIONING", true);
export const ENABLE_FUTURES_WEBSOCKET_SUMMARIES = readBoolean(
  "ENABLE_FUTURES_WEBSOCKET_SUMMARIES",
  true
);
export const ENABLE_POLYMARKET_BTC_5M = readBoolean("ENABLE_POLYMARKET_BTC_5M", true);
export const POSITION_SAMPLE_INTERVAL_MS = 5 * 1000;
export const EXPECTED_POSITION_SAMPLES_PER_MARKET =
  MARKET_MS / POSITION_SAMPLE_INTERVAL_MS;
export const BASIS_SAMPLE_PERIOD = process.env.BINANCE_BASIS_PERIOD || "5m";
export const FUTURES_BASIS_CONTRACT_TYPE =
  process.env.BINANCE_BASIS_CONTRACT_TYPE || "PERPETUAL";
export const LARGE_TRADE_QUOTE_THRESHOLD = readPositiveNumber(
  "LARGE_TRADE_QUOTE_THRESHOLD",
  1_000_000
);
export const AGG_TRADE_PAGE_LIMIT = 1000;
export const MAX_AGG_TRADE_PAGES_PER_MARKET = readPositiveNumber(
  "MAX_AGG_TRADE_PAGES_PER_MARKET",
  30
);
export const FUTURES_WS_SUMMARY_BUCKET_MS = 1000;
export const FUTURES_WS_FLUSH_INTERVAL_MS = readPositiveNumber("FUTURES_WS_FLUSH_INTERVAL_MS", 1000);
export const FUTURES_WS_FLUSH_LAG_MS = readPositiveNumber("FUTURES_WS_FLUSH_LAG_MS", 1500);
export const FUTURES_WS_RECONNECT_INITIAL_MS = readPositiveNumber("FUTURES_WS_RECONNECT_INITIAL_MS", 1000);
export const FUTURES_WS_RECONNECT_MAX_MS = readPositiveNumber("FUTURES_WS_RECONNECT_MAX_MS", 30000);
export const FUTURES_WS_STALE_MS = readPositiveNumber("FUTURES_WS_STALE_MS", 20000);
export const FORWARD_LABEL_HORIZONS_SECONDS = [1, 5, 10, 15, 30, 60];
export const FORWARD_LABEL_MIN_THRESHOLD_BPS = readPositiveNumber("FORWARD_LABEL_MIN_THRESHOLD_BPS", 1);

export const PRICE_SOURCES = [
  {
    source: "binance_spot",
    instrumentType: "spot",
    url: () =>
      buildUrl(BINANCE_SPOT_BASE_URL, "/api/v3/ticker/price", {
        symbol: SYMBOL,
      }),
    parse: (data) => ({ price: data.price, exchangeTime: null }),
  },
  {
    source: "binance_futures",
    instrumentType: "futures",
    url: () =>
      buildUrl(BINANCE_FUTURES_BASE_URL, "/fapi/v2/ticker/price", {
        symbol: SYMBOL,
      }),
    parse: (data) => ({
      price: data.price,
      exchangeTime: data.time ? new Date(Number(data.time)) : null,
    }),
  },
];

export const POLYMARKET_5M_BTC_SOURCE = {
  marketSource: "polymarket_gamma",
  probabilitySource: "polymarket_clob_midpoints",
  instrumentType: "prediction_market",
  gammaMarketBySlugUrl: (slug) =>
    `${POLYMARKET_GAMMA_BASE_URL}/markets/slug/${encodeURIComponent(slug)}`,
  midpointsUrl: () => `${POLYMARKET_CLOB_BASE_URL}/midpoints`,
};

export const FUTURES_MICROSTRUCTURE_SOURCE = {
  source: "binance_futures",
  instrumentType: "futures",
  depthUrl: () =>
    buildUrl(BINANCE_FUTURES_BASE_URL, "/fapi/v1/depth", {
      symbol: SYMBOL,
      limit: 20,
    }),
  markPriceUrl: () =>
    buildUrl(BINANCE_FUTURES_BASE_URL, "/fapi/v1/premiumIndex", {
      symbol: SYMBOL,
    }),
  openInterestUrl: () =>
    buildUrl(BINANCE_FUTURES_BASE_URL, "/fapi/v1/openInterest", {
      symbol: SYMBOL,
    }),
  basisUrl: ({
    startTime,
    endTime,
    limit = 10,
    period = BASIS_SAMPLE_PERIOD,
    contractType = FUTURES_BASIS_CONTRACT_TYPE,
  } = {}) =>
    buildUrl(BINANCE_FUTURES_BASE_URL, "/futures/data/basis", {
      pair: SYMBOL,
      contractType,
      period,
      limit,
      startTime,
      endTime,
    }),
  aggTradesUrl: ({ startTime, endTime, fromId, limit = AGG_TRADE_PAGE_LIMIT } = {}) =>
    buildUrl(BINANCE_FUTURES_BASE_URL, "/fapi/v1/aggTrades", {
      symbol: SYMBOL,
      startTime,
      endTime,
      fromId,
      limit,
    }),
};

export const FUTURES_WEBSOCKET_SOURCE = {
  source: "binance_futures_ws",
  instrumentType: "futures",
  streams: () => {
    const streamSymbol = SYMBOL.toLowerCase();
    return [`${streamSymbol}@bookTicker`, `${streamSymbol}@forceOrder`];
  },
  url: () => buildFuturesWebSocketUrl(FUTURES_WEBSOCKET_SOURCE.streams()),
};
