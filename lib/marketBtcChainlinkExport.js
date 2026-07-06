import { hasDatabaseConfig, query } from "./db.js";

const CSV_COLUMNS = [
  "market_id",
  "symbol",
  "seconds_from_start",
  "scheduled_at_utc",
  "btc_price_source",
  "btc_price",
  "btc_sample_type",
  "btc_collected_at_utc",
  "chainlink_btc_source",
  "chainlink_btc_price",
  "chainlink_sample_type",
  "chainlink_quality",
  "chainlink_tick_age_ms",
  "chainlink_collected_at_utc",
  "chainlink_price_timestamp_utc",
  "chainlink_server_timestamp_utc",
];

function sanitizeError(error) {
  if (!error) return "Unknown database error";
  return error.message || String(error);
}

function toIso(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toISOString().replace(".000Z", "Z");
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = value instanceof Date ? toIso(value) : String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function toCsv(rows) {
  const lines = [
    CSV_COLUMNS.join(","),
    ...rows.map((row) => CSV_COLUMNS.map((column) => csvCell(row[column])).join(",")),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

function normalizeRows(rows) {
  return rows.map((row) => ({
    market_id: row.market_id,
    symbol: row.symbol,
    seconds_from_start: row.seconds_from_start,
    scheduled_at_utc: toIso(row.scheduled_at),
    btc_price_source: row.btc_price_source || "btc_price",
    btc_price: row.btc_price,
    btc_sample_type: row.btc_sample_type,
    btc_collected_at_utc: toIso(row.btc_collected_at),
    chainlink_btc_source: row.chainlink_btc_source || "chainlink_btc",
    chainlink_btc_price: row.chainlink_btc_price,
    chainlink_sample_type: row.chainlink_sample_type,
    chainlink_quality: row.chainlink_quality,
    chainlink_tick_age_ms: row.chainlink_tick_age_ms,
    chainlink_collected_at_utc: toIso(row.chainlink_collected_at),
    chainlink_price_timestamp_utc: toIso(row.chainlink_price_timestamp),
    chainlink_server_timestamp_utc: toIso(row.chainlink_server_timestamp),
  }));
}

export async function getMarketBtcChainlinkCsvExport(marketId) {
  if (!hasDatabaseConfig()) {
    return {
      ok: false,
      status: 503,
      error: "DATABASE_URL is not configured.",
    };
  }

  if (!marketId) {
    return {
      ok: false,
      status: 400,
      error: "Market id is required.",
    };
  }

  try {
    const result = await query(
      `
        with market as (
          select id, symbol, start_time, end_time
          from markets
          where id = $1
          limit 1
        ),
        expected as (
          select generate_series(
            market.start_time,
            market.end_time,
            interval '5 seconds'
          ) as scheduled_at
          from market
        ),
        btc_samples as (
          select distinct on (price_samples.scheduled_at)
            price_samples.scheduled_at,
            price_samples.collected_at,
            price_samples.source,
            price_samples.sample_type,
            price_samples.price
          from price_samples
          cross join market
          where price_samples.symbol = market.symbol
            and price_samples.source = 'binance_futures'
            and price_samples.scheduled_at >= market.start_time
            and price_samples.scheduled_at <= market.end_time
          order by
            price_samples.scheduled_at,
            case price_samples.sample_type
              when 'close' then 0
              when 'normal' then 1
              when 'final_ramp' then 2
              else 3
            end,
            price_samples.collected_at desc
        ),
        chainlink_samples as (
          select distinct on (chainlink_btc_price_samples.scheduled_at)
            chainlink_btc_price_samples.scheduled_at,
            chainlink_btc_price_samples.collected_at,
            chainlink_btc_price_samples.source,
            chainlink_btc_price_samples.sample_type,
            chainlink_btc_price_samples.price,
            chainlink_btc_price_samples.quality,
            chainlink_btc_price_samples.tick_age_ms,
            chainlink_btc_price_samples.price_timestamp,
            chainlink_btc_price_samples.server_timestamp
          from chainlink_btc_price_samples
          cross join market
          where chainlink_btc_price_samples.market_id = market.id
            and chainlink_btc_price_samples.scheduled_at >= market.start_time
            and chainlink_btc_price_samples.scheduled_at <= market.end_time
          order by
            chainlink_btc_price_samples.scheduled_at,
            case chainlink_btc_price_samples.quality
              when 'complete' then 0
              when 'partial' then 1
              when 'missing' then 2
              else 3
            end,
            chainlink_btc_price_samples.collected_at desc
        )
        select
          market.id as market_id,
          market.symbol,
          extract(epoch from (expected.scheduled_at - market.start_time))::int as seconds_from_start,
          expected.scheduled_at,
          btc_samples.source as btc_price_source,
          btc_samples.price as btc_price,
          btc_samples.sample_type as btc_sample_type,
          btc_samples.collected_at as btc_collected_at,
          chainlink_samples.source as chainlink_btc_source,
          chainlink_samples.price as chainlink_btc_price,
          chainlink_samples.sample_type as chainlink_sample_type,
          chainlink_samples.quality as chainlink_quality,
          chainlink_samples.tick_age_ms as chainlink_tick_age_ms,
          chainlink_samples.collected_at as chainlink_collected_at,
          chainlink_samples.price_timestamp as chainlink_price_timestamp,
          chainlink_samples.server_timestamp as chainlink_server_timestamp
        from market
        join expected on true
        left join btc_samples on btc_samples.scheduled_at = expected.scheduled_at
        left join chainlink_samples on chainlink_samples.scheduled_at = expected.scheduled_at
        order by expected.scheduled_at asc
      `,
      [marketId]
    );

    if (result.rows.length === 0) {
      return { ok: false, status: 404, error: "Market not found." };
    }

    const rows = normalizeRows(result.rows);
    return {
      ok: true,
      rows,
      csv: toCsv(rows),
    };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: sanitizeError(error),
    };
  }
}

export function marketBtcChainlinkCsvFilename(marketId) {
  const safeId = String(marketId || "market").replace(/[^A-Za-z0-9._-]+/g, "-");
  return `market_btc_chainlink_${safeId}.csv`;
}
