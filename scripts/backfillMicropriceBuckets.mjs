import { loadLocalEnv } from "../lib/env.js";

loadLocalEnv();

const { closePool, hasDatabaseConfig, query } = await import("../lib/db.js");
const { writeMarketMicropriceBuckets } = await import("../collector/marketMicropriceBuckets.mjs");

function readLimit() {
  const rawValue = process.argv[2] || process.env.MICROPRICE_BACKFILL_LIMIT || null;
  if (rawValue === null || rawValue === "" || rawValue === "all") return null;

  const value = Number(rawValue);
  return Number.isInteger(value) && value > 0 ? value : null;
}

async function getMarkets(limit) {
  const result = await query(
    `
      with target_markets as (
        select m.id, m.symbol, m.start_time, m.end_time
        from markets m
        where m.status in ('closed', 'incomplete')
          and exists (
            select 1
            from futures_ws_1s_summaries s
            where s.symbol = m.symbol
              and s.source = 'binance_futures_ws'
              and s.bucket_start >= m.start_time
              and s.bucket_start < m.end_time
          )
        order by m.start_time desc
        limit $1
      )
      select *
      from target_markets
      order by start_time asc
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
    const result = await writeMarketMicropriceBuckets(market);
    totalBuckets += result.micropriceBucketCount;
    console.log(
      `${market.id}: wrote ${result.micropriceBucketCount} microprice bucket rows ` +
        `(complete ${result.completeCount}, partial ${result.partialCount}, stale ${result.staleCount}, missing ${result.missingCount})`
    );
  }

  console.log(`Backfilled ${totalBuckets} microprice bucket rows across ${markets.length} markets.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
