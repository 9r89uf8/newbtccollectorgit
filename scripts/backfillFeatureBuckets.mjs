import { loadLocalEnv } from "../lib/env.js";

loadLocalEnv();

const { closePool, hasDatabaseConfig, query } = await import("../lib/db.js");
const { writeMarketFeatureBuckets } = await import("../collector/marketFeatureBuckets.mjs");

function readLimit() {
  const rawValue = process.argv[2] || process.env.BUCKET_BACKFILL_LIMIT || 288;
  const value = Number(rawValue);
  return Number.isInteger(value) && value > 0 ? value : 288;
}

async function getMarkets(limit) {
  const result = await query(
    `
      select m.id, m.symbol, m.start_time, m.end_time
      from markets m
      where m.status in ('closed', 'incomplete')
        and exists (
          select 1
          from book_samples b
          where b.symbol = m.symbol
            and b.source = 'binance_futures'
            and b.scheduled_at >= m.start_time
            and b.scheduled_at < m.end_time
        )
      order by m.start_time desc
      limit $1
    `,
    [limit]
  );

  return result.rows.map((row) => ({
    id: row.id,
    symbol: row.symbol,
    start: new Date(row.start_time),
    end: new Date(row.end_time),
    startMs: new Date(row.start_time).getTime(),
    endMs: new Date(row.end_time).getTime(),
  }));
}

async function main() {
  if (!hasDatabaseConfig()) {
    console.error("DATABASE_URL is not set. Add it to .env or your shell environment.");
    process.exitCode = 1;
    return;
  }

  const limit = readLimit();
  const markets = await getMarkets(limit);
  let totalBuckets = 0;

  for (const market of markets) {
    const result = await writeMarketFeatureBuckets(market);
    totalBuckets += result.bucketCount;
    console.log(`${market.id}: wrote ${result.bucketCount} bucket rows`);
  }

  console.log(`Backfilled ${totalBuckets} bucket rows across ${markets.length} markets.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
