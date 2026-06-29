import { query } from "../lib/db.js";
import {
  POLYMARKET_5M_BTC_SOURCE,
  POLYMARKET_TIMEOUT_MS,
} from "./config.mjs";
import { fetchJson, postJson } from "./http.mjs";
import { recordError } from "./store.mjs";

const marketCache = new Map();
const metadataPrefetchFailures = new Map();
const SETTLEMENT_REFRESH_LIMIT = 12;
const METADATA_PREFETCH_RETRY_MS = 10_000;

function parseJsonish(value) {
  if (value === null || value === undefined || value === "") return null;
  if (Array.isArray(value) || typeof value === "object") return value;
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readProbability(value) {
  const number = readNumber(value);
  if (number === null || number < 0 || number > 1) return null;
  return number;
}

function readDate(value) {
  if (!value) return null;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time : null;
}

function normalizeOutcome(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "up") return "up";
  if (normalized === "down") return "down";
  return normalized;
}

function findNestedNumber(value, names) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedNumber(item, names);
      if (found !== null) return found;
    }
    return null;
  }

  if (!value || typeof value !== "object") return null;

  for (const [key, child] of Object.entries(value)) {
    if (names.has(key)) {
      const number = readNumber(child);
      if (number !== null) return number;
    }

    const found = findNestedNumber(child, names);
    if (found !== null) return found;
  }

  return null;
}

function getEventMetadata(raw) {
  const events = raw?.events;
  if (Array.isArray(events)) {
    for (const event of events) {
      if (event?.eventMetadata) return event.eventMetadata;
    }
    return null;
  }
  return events?.eventMetadata || null;
}

function mapOutcomeTokens(raw) {
  const outcomes = parseJsonish(raw.outcomes) || parseJsonish(raw.shortOutcomes);
  const tokenIds = parseJsonish(raw.clobTokenIds);

  if (!Array.isArray(outcomes) || !Array.isArray(tokenIds)) {
    return { outcomes: [], upTokenId: null, downTokenId: null };
  }

  const outcomeToToken = new Map();
  for (let index = 0; index < Math.min(outcomes.length, tokenIds.length); index += 1) {
    outcomeToToken.set(normalizeOutcome(outcomes[index]), String(tokenIds[index]));
  }

  return {
    outcomes,
    upTokenId: outcomeToToken.get("up") || null,
    downTokenId: outcomeToToken.get("down") || null,
  };
}

function inferWinningOutcome(raw, outcomes, priceToBeat, endPrice) {
  if (priceToBeat !== null && endPrice !== null) {
    return endPrice >= priceToBeat ? "up" : "down";
  }

  if (raw.closed !== true) return "unknown";

  const outcomePrices = parseJsonish(raw.outcomePrices);
  if (!Array.isArray(outcomes) || !Array.isArray(outcomePrices)) return "unknown";

  let bestOutcome = null;
  let bestPrice = -Infinity;
  for (let index = 0; index < Math.min(outcomes.length, outcomePrices.length); index += 1) {
    const price = readNumber(outcomePrices[index]);
    if (price !== null && price > bestPrice) {
      bestOutcome = normalizeOutcome(outcomes[index]);
      bestPrice = price;
    }
  }

  return bestPrice >= 0.99 && ["up", "down"].includes(bestOutcome) ? bestOutcome : "unknown";
}

function gammaStatus(raw) {
  if (raw.umaResolutionStatus) return String(raw.umaResolutionStatus);
  if (raw.comboStatus) return String(raw.comboStatus);
  if (raw.closed === true) return "closed";
  if (raw.active === true) return "active";
  return null;
}

function parsePolymarketMarket(raw, market) {
  const slug = String(raw.slug || slugForMarket(market));
  const { outcomes, upTokenId, downTokenId } = mapOutcomeTokens(raw);
  const eventMetadata = getEventMetadata(raw);
  const priceToBeat =
    readNumber(eventMetadata?.priceToBeat) ??
    findNestedNumber(raw, new Set(["priceToBeat", "price_to_beat", "priceToBeatValue"]));
  const endPrice =
    readNumber(eventMetadata?.finalPrice) ??
    readNumber(eventMetadata?.endPrice) ??
    findNestedNumber(raw, new Set(["finalPrice", "final_price", "endPrice", "end_price"]));
  const winningOutcome = inferWinningOutcome(raw, outcomes, priceToBeat, endPrice);

  return {
    source: POLYMARKET_5M_BTC_SOURCE.marketSource,
    marketId: market.id,
    symbol: market.symbol,
    slug,
    polymarketMarketId: raw.id === null || raw.id === undefined ? null : String(raw.id),
    conditionId: raw.conditionId || null,
    startTime: market.start,
    endTime: market.end,
    gammaStartDate: readDate(raw.startDate),
    gammaEndDate: readDate(raw.endDate),
    upTokenId,
    downTokenId,
    priceToBeat,
    endPrice,
    winningOutcome,
    active: typeof raw.active === "boolean" ? raw.active : null,
    closed: typeof raw.closed === "boolean" ? raw.closed : null,
    acceptingOrders: typeof raw.acceptingOrders === "boolean" ? raw.acceptingOrders : null,
    automaticallyResolved:
      typeof raw.automaticallyResolved === "boolean" ? raw.automaticallyResolved : null,
    gammaStatus: gammaStatus(raw),
    resolvedAt: winningOutcome === "unknown" ? null : readDate(raw.closedTime) || readDate(raw.umaEndDate),
    rawGamma: raw,
  };
}

function dbMarketFromRow(row) {
  return {
    source: row.source,
    marketId: row.market_id,
    symbol: row.symbol,
    slug: row.slug,
    polymarketMarketId: row.polymarket_market_id,
    conditionId: row.condition_id,
    startTime: new Date(row.start_time),
    endTime: new Date(row.end_time),
    gammaStartDate: row.gamma_start_date ? new Date(row.gamma_start_date) : null,
    gammaEndDate: row.gamma_end_date ? new Date(row.gamma_end_date) : null,
    upTokenId: row.up_token_id,
    downTokenId: row.down_token_id,
    priceToBeat: readNumber(row.price_to_beat),
    endPrice: readNumber(row.end_price),
    winningOutcome: row.winning_outcome || "unknown",
    active: row.active,
    closed: row.closed,
    acceptingOrders: row.accepting_orders,
    automaticallyResolved: row.automatically_resolved,
    gammaStatus: row.gamma_status,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
    rawGamma: row.raw_gamma,
  };
}

function normalizePair(upProbability, downProbability) {
  if (upProbability === null || downProbability === null) {
    return { upProbabilityNormalized: null, downProbabilityNormalized: null, probabilitySum: null };
  }

  const probabilitySum = upProbability + downProbability;
  if (probabilitySum <= 0) {
    return { upProbabilityNormalized: null, downProbabilityNormalized: null, probabilitySum };
  }

  return {
    upProbabilityNormalized: upProbability / probabilitySum,
    downProbabilityNormalized: downProbability / probabilitySum,
    probabilitySum,
  };
}

function qualityForPair(upProbability, downProbability) {
  if (upProbability !== null && downProbability !== null) return "complete";
  if (upProbability !== null || downProbability !== null) return "partial";
  return "missing";
}

export function slugForMarket(market) {
  return `btc-updown-5m-${Math.floor(market.startMs / 1000)}`;
}

export function shouldCollectPolymarketProbabilitySample(market, scheduledAt, sampleType) {
  const scheduledMs = scheduledAt.getTime();
  return sampleType !== "close" && scheduledMs >= market.startMs && scheduledMs < market.endMs;
}

async function fetchGammaMarket(market) {
  const slug = slugForMarket(market);
  const { data } = await fetchJson(
    POLYMARKET_5M_BTC_SOURCE.gammaMarketBySlugUrl(slug),
    POLYMARKET_TIMEOUT_MS
  );
  return parsePolymarketMarket(data, market);
}

async function upsertPolymarketMarket(parsed) {
  await query(
    `
      insert into polymarket_5m_btc_markets
        (
          source,
          market_id,
          symbol,
          slug,
          polymarket_market_id,
          condition_id,
          start_time,
          end_time,
          gamma_start_date,
          gamma_end_date,
          up_token_id,
          down_token_id,
          price_to_beat,
          end_price,
          winning_outcome,
          active,
          closed,
          accepting_orders,
          automatically_resolved,
          gamma_status,
          last_metadata_refresh_at,
          resolved_at,
          raw_gamma
        )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19,
        $20, now(), $21, $22::jsonb
      )
      on conflict (source, market_id) do update set
        symbol = excluded.symbol,
        slug = excluded.slug,
        polymarket_market_id = excluded.polymarket_market_id,
        condition_id = excluded.condition_id,
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        gamma_start_date = excluded.gamma_start_date,
        gamma_end_date = excluded.gamma_end_date,
        up_token_id = excluded.up_token_id,
        down_token_id = excluded.down_token_id,
        price_to_beat = excluded.price_to_beat,
        end_price = excluded.end_price,
        winning_outcome = excluded.winning_outcome,
        active = excluded.active,
        closed = excluded.closed,
        accepting_orders = excluded.accepting_orders,
        automatically_resolved = excluded.automatically_resolved,
        gamma_status = excluded.gamma_status,
        last_metadata_refresh_at = excluded.last_metadata_refresh_at,
        resolved_at = coalesce(excluded.resolved_at, polymarket_5m_btc_markets.resolved_at),
        raw_gamma = excluded.raw_gamma
    `,
    [
      parsed.source,
      parsed.marketId,
      parsed.symbol,
      parsed.slug,
      parsed.polymarketMarketId,
      parsed.conditionId,
      parsed.startTime,
      parsed.endTime,
      parsed.gammaStartDate,
      parsed.gammaEndDate,
      parsed.upTokenId,
      parsed.downTokenId,
      parsed.priceToBeat,
      parsed.endPrice,
      parsed.winningOutcome,
      parsed.active,
      parsed.closed,
      parsed.acceptingOrders,
      parsed.automaticallyResolved,
      parsed.gammaStatus,
      parsed.resolvedAt,
      JSON.stringify(parsed.rawGamma),
    ]
  );

  marketCache.set(parsed.marketId, parsed);
  return parsed;
}

async function loadStoredPolymarketMarket(market) {
  const result = await query(
    `
      select *
      from polymarket_5m_btc_markets
      where source = $1
        and market_id = $2
      limit 1
    `,
    [POLYMARKET_5M_BTC_SOURCE.marketSource, market.id]
  );

  const row = result.rows[0];
  if (!row) return null;
  const parsed = dbMarketFromRow(row);
  marketCache.set(market.id, parsed);
  return parsed;
}

export async function refreshPolymarketMarketMetadata(market) {
  const parsed = await fetchGammaMarket(market);
  return upsertPolymarketMarket(parsed);
}

export async function prefetchPolymarketMarketMetadata(market, nowMs = Date.now()) {
  const cached = marketCache.get(market.id);
  if (cached?.upTokenId && cached?.downTokenId) {
    return { ok: true, source: POLYMARKET_5M_BTC_SOURCE.marketSource, marketId: market.id, cached: true };
  }

  const lastFailureMs = metadataPrefetchFailures.get(market.id) || 0;
  if (nowMs - lastFailureMs < METADATA_PREFETCH_RETRY_MS) {
    return { ok: false, source: POLYMARKET_5M_BTC_SOURCE.marketSource, marketId: market.id, skipped: true };
  }

  try {
    const stored = await loadStoredPolymarketMarket(market);
    if (stored?.upTokenId && stored?.downTokenId) {
      metadataPrefetchFailures.delete(market.id);
      return { ok: true, source: POLYMARKET_5M_BTC_SOURCE.marketSource, marketId: market.id, stored: true };
    }

    const parsed = await fetchGammaMarket(market);
    marketCache.set(market.id, parsed);
    metadataPrefetchFailures.delete(market.id);
    return {
      ok: Boolean(parsed.upTokenId && parsed.downTokenId),
      source: POLYMARKET_5M_BTC_SOURCE.marketSource,
      marketId: market.id,
      fetched: true,
    };
  } catch (error) {
    metadataPrefetchFailures.set(market.id, nowMs);
    return { ok: false, source: POLYMARKET_5M_BTC_SOURCE.marketSource, marketId: market.id, error };
  }
}

async function ensurePolymarketMarket(market) {
  const cached = marketCache.get(market.id);
  if (cached?.upTokenId && cached?.downTokenId) return cached;

  const stored = await loadStoredPolymarketMarket(market);
  if (stored?.upTokenId && stored?.downTokenId) return stored;

  const refreshed = await refreshPolymarketMarketMetadata(market);
  if (!refreshed.upTokenId || !refreshed.downTokenId) {
    throw new Error(`Polymarket ${refreshed.slug} is missing Up/Down CLOB token ids`);
  }

  return refreshed;
}

async function insertProbabilitySample(market, metadata, scheduledAt, sampleType, midpointResult) {
  const upProbability = readProbability(midpointResult.data[metadata.upTokenId]);
  const downProbability = readProbability(midpointResult.data[metadata.downTokenId]);
  const quality = qualityForPair(upProbability, downProbability);
  const normalized = normalizePair(upProbability, downProbability);

  await query(
    `
      insert into polymarket_probability_samples
        (
          source,
          market_id,
          symbol,
          slug,
          scheduled_at,
          collected_at,
          sample_type,
          up_token_id,
          down_token_id,
          up_probability,
          down_probability,
          up_probability_normalized,
          down_probability_normalized,
          probability_sum,
          request_latency_ms,
          quality,
          raw_response
        )
      values (
        $1, $2, $3, $4, $5, now(), $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16::jsonb
      )
      on conflict (source, market_id, scheduled_at) do update set
        collected_at = excluded.collected_at,
        sample_type = excluded.sample_type,
        up_token_id = excluded.up_token_id,
        down_token_id = excluded.down_token_id,
        up_probability = excluded.up_probability,
        down_probability = excluded.down_probability,
        up_probability_normalized = excluded.up_probability_normalized,
        down_probability_normalized = excluded.down_probability_normalized,
        probability_sum = excluded.probability_sum,
        request_latency_ms = excluded.request_latency_ms,
        quality = excluded.quality,
        raw_response = excluded.raw_response,
        updated_at = now()
    `,
    [
      POLYMARKET_5M_BTC_SOURCE.probabilitySource,
      market.id,
      market.symbol,
      metadata.slug,
      scheduledAt,
      sampleType,
      metadata.upTokenId,
      metadata.downTokenId,
      upProbability,
      downProbability,
      normalized.upProbabilityNormalized,
      normalized.downProbabilityNormalized,
      normalized.probabilitySum,
      midpointResult.latencyMs,
      quality,
      JSON.stringify(midpointResult.data),
    ]
  );

  return { quality, upProbability, downProbability };
}

async function fetchMidpoints(metadata) {
  return postJson(
    POLYMARKET_5M_BTC_SOURCE.midpointsUrl(),
    [{ token_id: metadata.upTokenId }, { token_id: metadata.downTokenId }],
    POLYMARKET_TIMEOUT_MS
  );
}

export async function collectPolymarketProbabilitySample(market, scheduledAt, sampleType) {
  if (!shouldCollectPolymarketProbabilitySample(market, scheduledAt, sampleType)) {
    return { ok: true, source: POLYMARKET_5M_BTC_SOURCE.probabilitySource, skipped: true };
  }

  try {
    const metadata = await ensurePolymarketMarket(market);
    const midpointResult = await fetchMidpoints(metadata);
    const sample = await insertProbabilitySample(market, metadata, scheduledAt, sampleType, midpointResult);

    if (sample.quality === "missing") {
      await recordError({
        marketId: market.id,
        source: POLYMARKET_5M_BTC_SOURCE.probabilitySource,
        errorType: "polymarket_midpoints_missing",
        message: `No midpoint prices returned for ${metadata.slug}`,
      });
    }

    return {
      ok: sample.quality !== "missing",
      source: POLYMARKET_5M_BTC_SOURCE.probabilitySource,
      quality: sample.quality,
    };
  } catch (error) {
    await recordError({
      marketId: market.id,
      source: POLYMARKET_5M_BTC_SOURCE.probabilitySource,
      errorType: error.name === "AbortError" ? "timeout" : "polymarket_probability_fetch_error",
      message: error.message || String(error),
    });
    return { ok: false, source: POLYMARKET_5M_BTC_SOURCE.probabilitySource, error };
  }
}

export async function refreshRecentPolymarketSettlements(limit = SETTLEMENT_REFRESH_LIMIT) {
  const result = await query(
    `
      select market_id, symbol, start_time, end_time
      from polymarket_5m_btc_markets
      where source = $1
        and end_time <= now()
        and start_time >= now() - interval '24 hours'
        and (
          closed is distinct from true
          or end_price is null
          or winning_outcome is null
          or winning_outcome = 'unknown'
        )
        and (
          last_metadata_refresh_at is null
          or last_metadata_refresh_at <= now() - interval '15 seconds'
        )
      order by end_time desc
      limit $2
    `,
    [POLYMARKET_5M_BTC_SOURCE.marketSource, limit]
  );

  const refreshed = [];
  const failures = [];

  for (const row of result.rows) {
    const market = {
      id: row.market_id,
      symbol: row.symbol,
      start: new Date(row.start_time),
      end: new Date(row.end_time),
      startMs: new Date(row.start_time).getTime(),
      endMs: new Date(row.end_time).getTime(),
    };

    try {
      refreshed.push(await refreshPolymarketMarketMetadata(market));
    } catch (error) {
      failures.push({ marketId: market.id, error });
      await recordError({
        marketId: market.id,
        source: POLYMARKET_5M_BTC_SOURCE.marketSource,
        errorType: error.name === "AbortError" ? "timeout" : "polymarket_metadata_refresh_error",
        message: error.message || String(error),
      });
    }
  }

  return {
    ok: failures.length === 0,
    refreshedCount: refreshed.length,
    failureCount: failures.length,
  };
}

export async function getPolymarketProbabilitySampleStats(market) {
  const result = await query(
    `
      select
        count(*)::int as sample_count,
        count(*) filter (where quality = 'complete')::int as complete_count,
        count(*) filter (where quality = 'partial')::int as partial_count,
        count(*) filter (where quality = 'missing')::int as missing_count,
        min(scheduled_at) as first_sample_at,
        max(scheduled_at) as last_sample_at
      from polymarket_probability_samples
      where source = $1
        and market_id = $2
    `,
    [POLYMARKET_5M_BTC_SOURCE.probabilitySource, market.id]
  );

  return result.rows[0] || null;
}
