import { loadLocalEnv } from "../lib/env.js";

loadLocalEnv();

const { closePool, hasDatabaseConfig, query } = await import("../lib/db.js");
const { writeMarketLabels } = await import("../collector/marketLabels.mjs");

function parseArgs(argv) {
  const args = {
    marketId: "",
    since: "2026-06-27T00:00:00Z",
    limit: 10000,
  };

  for (const arg of argv) {
    if (arg.startsWith("--market-id=")) {
      args.marketId = arg.slice("--market-id=".length);
    } else if (arg.startsWith("--since=")) {
      args.since = arg.slice("--since=".length);
    } else if (arg.startsWith("--limit=")) {
      const value = Number(arg.slice("--limit=".length));
      if (Number.isInteger(value) && value > 0) args.limit = value;
    } else if (arg.includes("_")) {
      args.marketId = arg;
    }
  }

  return args;
}

function toMarket(row) {
  const start = new Date(row.start_time);
  const end = new Date(row.end_time);
  return {
    id: row.id,
    symbol: row.symbol,
    start,
    end,
    startMs: start.getTime(),
    endMs: end.getTime(),
  };
}

async function getMarkets({ marketId, since, limit }) {
  const params = [];
  const filters = ["m.status in ('closed', 'incomplete')"];

  if (marketId) {
    params.push(marketId);
    filters.push(`m.id = $${params.length}`);
  } else {
    params.push(since);
    filters.push(`m.start_time >= $${params.length}::timestamptz`);
  }

  params.push(limit);
  const limitParam = `$${params.length}`;

  const result = await query(
    `
      select
        m.id,
        m.symbol,
        m.start_time,
        m.end_time,
        m.status,
        exists (
          select 1
          from collection_errors ce
          where ce.market_id = m.id
        ) as has_errors
      from markets m
      where ${filters.join(" and ")}
      order by m.start_time asc
      limit ${limitParam}
    `,
    params
  );

  return result.rows;
}

async function updateStatus(marketId, status) {
  await query(
    `
      update markets
      set status = $2,
          closed_at = coalesce(closed_at, now())
      where id = $1
        and status <> $2
    `,
    [marketId, status]
  );
}

async function main() {
  if (!hasDatabaseConfig()) {
    console.error("DATABASE_URL is not set. Add it to .env or your shell environment.");
    process.exitCode = 1;
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  const rows = await getMarkets(args);
  let changed = 0;

  for (const row of rows) {
    const labels = await writeMarketLabels(toMarket(row));
    const allComplete = labels.every((label) => label.quality === "complete");
    const nextStatus = row.has_errors ? row.status : allComplete ? "closed" : "incomplete";

    if (nextStatus !== row.status) {
      await updateStatus(row.id, nextStatus);
      changed += 1;
    }

    const labelSummary = labels.map((label) => `${label.source}:${label.quality}`).join(", ");
    const errorNote = row.has_errors ? " preserved-errors" : "";
    console.log(`${row.id}: ${row.status} -> ${nextStatus}; ${labelSummary}${errorNote}`);
  }

  console.log(`Reconciled ${rows.length} markets; status changed for ${changed}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });