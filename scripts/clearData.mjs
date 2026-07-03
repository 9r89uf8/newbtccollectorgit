import { loadLocalEnv } from "../lib/env.js";

loadLocalEnv();

const { closePool, getPool, hasDatabaseConfig } = await import("../lib/db.js");

const CONFIRMATION = "DELETE_ALL_MARKET_DATA";
const DATA_TABLES = [
  "market_forward_labels",
  "polymarket_probability_samples",
  "chainlink_btc_price_samples",
  "polymarket_5m_btc_markets",
  "market_labels",
  "market_features",
  "market_position_features",
  "market_behavior_labels",
  "market_trade_flow_1s",
  "market_microprice_buckets",
  "market_cvd_buckets",
  "market_feature_buckets",
  "market_classifications",
  "futures_ws_1s_summaries",
  "futures_basis_samples",
  "derivative_position_samples",
  "book_samples",
  "agg_trades",
  "price_samples",
  "markets",
  "collector_heartbeats",
  "collection_errors",
];

function usage() {
  console.error("Usage:");
  console.error("  npm run db:clear-data -- --dry-run");
  console.error(`  npm run db:clear-data -- --confirm=${CONFIRMATION}`);
  console.error("");
  console.error("Stop the collector before clearing data, otherwise it can immediately write new rows.");
}

function hasConfirmation(args) {
  return (
    args.includes(`--confirm=${CONFIRMATION}`) ||
    process.env.CONFIRM_DELETE_ALL_DATA === CONFIRMATION
  );
}

function quoteIdentifier(identifier) {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe table identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

async function getTableCounts(client) {
  const counts = [];

  for (const table of DATA_TABLES) {
    const result = await client.query(
      `select count(*)::text as row_count from ${quoteIdentifier(table)}`
    );
    counts.push({ table, rowCount: BigInt(result.rows[0].row_count) });
  }

  return counts;
}

function printCounts(label, counts) {
  console.log(label);
  for (const { table, rowCount } of counts) {
    console.log(`  ${table}: ${rowCount.toString()}`);
  }

  const total = counts.reduce((sum, item) => sum + item.rowCount, 0n);
  console.log(`  total: ${total.toString()}`);
}

async function getActiveCollector(client) {
  const result = await client.query(
    `
      select collector_name, status, last_seen_at
      from collector_heartbeats
      where status <> 'stopped'
        and last_seen_at >= now() - interval '30 seconds'
      order by last_seen_at desc
      limit 1
    `
  );

  return result.rows[0] || null;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const confirmed = hasConfirmation(args);

  if (!dryRun && !confirmed) {
    usage();
    process.exitCode = 1;
    return;
  }

  if (!hasDatabaseConfig()) {
    console.error("DATABASE_URL is not set. Add it to .env or your shell environment.");
    process.exitCode = 1;
    return;
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    const beforeCounts = await getTableCounts(client);
    printCounts(dryRun ? "Rows that would be cleared:" : "Rows before clear:", beforeCounts);

    if (dryRun) return;

    const activeCollector = await getActiveCollector(client);
    if (activeCollector && !args.includes("--allow-running-collector")) {
      console.error("");
      console.error(
        `Refusing to clear data while collector ${activeCollector.collector_name} appears ${activeCollector.status}.`
      );
      console.error("Stop the collector first, or pass --allow-running-collector if this is intentional.");
      process.exitCode = 1;
      return;
    }

    await client.query("begin");
    await client.query(
      `truncate table ${DATA_TABLES.map(quoteIdentifier).join(", ")} restart identity cascade`
    );
    const afterCounts = await getTableCounts(client);
    await client.query("commit");

    printCounts("Rows after clear:", afterCounts);
    console.log("Database data clear complete. Schema and indexes were preserved.");
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // The transaction may not have started yet.
    }
    throw error;
  } finally {
    client.release();
    await closePool();
  }
}

main().catch(async (error) => {
  console.error(error);
  await closePool();
  process.exit(1);
});
