import { query } from "../lib/db.js";
import { EXPECTED_PRICE_SAMPLES_PER_SOURCE, PRICE_SOURCES } from "./config.mjs";

async function labelSource(market, sourceConfig) {
  const sampleResult = await query(
    `
      with source_samples as (
        select scheduled_at, price
        from price_samples
        where symbol = $1
          and source = $2
          and scheduled_at >= $3
          and scheduled_at <= $4
      ),
      counts as (
        select
          count(*)::int as sample_count,
          min(scheduled_at) as first_sample_at,
          max(scheduled_at) as last_sample_at
        from source_samples
      ),
      open_sample as (
        select scheduled_at, price
        from source_samples
        order by scheduled_at asc
        limit 1
      ),
      close_sample as (
        select scheduled_at, price
        from source_samples
        order by scheduled_at desc
        limit 1
      )
      select
        counts.sample_count,
        counts.first_sample_at,
        counts.last_sample_at,
        open_sample.price as open_price,
        close_sample.price as close_price
      from counts
      left join open_sample on true
      left join close_sample on true
    `,
    [market.symbol, sourceConfig.source, market.start, market.end]
  );

  const row = sampleResult.rows[0];
  if (!row || !row.open_price || !row.close_price) {
    return { source: sourceConfig.source, quality: "missing" };
  }

  const openPrice = Number(row.open_price);
  const closePrice = Number(row.close_price);
  const sampleCount = Number(row.sample_count);
  const returnPct = ((closePrice - openPrice) / openPrice) * 100;
  const direction = closePrice > openPrice ? "up" : closePrice < openPrice ? "down" : "flat";
  const hasExactOpen = new Date(row.first_sample_at).getTime() === market.startMs;
  const hasExactClose = new Date(row.last_sample_at).getTime() === market.endMs;
  const quality =
    sampleCount >= EXPECTED_PRICE_SAMPLES_PER_SOURCE && hasExactOpen && hasExactClose
      ? "complete"
      : "partial";

  await query(
    `
      insert into market_labels
        (
          market_id,
          source,
          open_price,
          close_price,
          return_pct,
          direction,
          sample_count,
          quality
        )
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      on conflict (market_id, source) do update set
        open_price = excluded.open_price,
        close_price = excluded.close_price,
        return_pct = excluded.return_pct,
        direction = excluded.direction,
        sample_count = excluded.sample_count,
        quality = excluded.quality,
        created_at = now()
    `,
    [
      market.id,
      sourceConfig.source,
      openPrice,
      closePrice,
      returnPct,
      direction,
      sampleCount,
      quality,
    ]
  );

  return { source: sourceConfig.source, quality };
}

export async function writeMarketLabels(market) {
  return Promise.all(PRICE_SOURCES.map((sourceConfig) => labelSource(market, sourceConfig)));
}
