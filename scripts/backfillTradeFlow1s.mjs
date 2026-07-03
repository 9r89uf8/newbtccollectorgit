import { loadLocalEnv } from "../lib/env.js";

loadLocalEnv();

const { closePool, hasDatabaseConfig, query } = await import("../lib/db.js");
const { writeMarketTradeFlow1s } = await import("../collector/marketTradeFlow1s.mjs");

function readLimit() {
  const rawValue = process.argv[2] || process.env.TRADE_FLOW_1S_BACKFILL_LIMIT || null;
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
            from agg_trades t
            where t.symbol = m.symbol
              and t.source = 'binance_futures'
              and t.trade_time >= m.start_time
              and t.trade_time < m.end_time
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
    const result = await writeMarketTradeFlow1s(market, { bucketQuality: "complete" });
    totalBuckets += result.tradeFlowBucketCount;
    console.log(`${market.id}: wrote ${result.tradeFlowBucketCount} 1s trade-flow rows`);
  }

  console.log(`Backfilled ${totalBuckets} 1s trade-flow rows across ${markets.length} markets.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });