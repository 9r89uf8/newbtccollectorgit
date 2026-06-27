import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadLocalEnv } from "../lib/env.js";

loadLocalEnv();
const { closePool, getPool, hasDatabaseConfig } = await import("../lib/db.js");

const schemaPath = resolve(process.cwd(), "db", "schema.sql");
const hypertables = [
  { table: "price_samples", timeColumn: "scheduled_at" },
  { table: "book_samples", timeColumn: "scheduled_at" },
  { table: "derivative_position_samples", timeColumn: "scheduled_at" },
  { table: "futures_ws_1s_summaries", timeColumn: "bucket_start" },
  { table: "market_forward_labels", timeColumn: "bucket_start" },
];

async function enableTimescaleIfAvailable(client) {
  try {
    await client.query("create extension if not exists timescaledb");
  } catch (error) {
    console.log("TimescaleDB not enabled. Core PostgreSQL schema is ready.");
    console.log(`Reason: ${error.message}`);
    return;
  }

  for (const hypertable of hypertables) {
    try {
      await client.query(
        `select create_hypertable('${hypertable.table}', '${hypertable.timeColumn}', if_not_exists => true)`
      );
      console.log(`TimescaleDB enabled for ${hypertable.table}.`);
    } catch (error) {
      console.log(`TimescaleDB not enabled for ${hypertable.table}.`);
      console.log(`Reason: ${error.message}`);
    }
  }
}

async function main() {
  if (!hasDatabaseConfig()) {
    console.error("DATABASE_URL is not set. Add it to .env or your shell environment.");
    process.exitCode = 1;
    return;
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    const schema = readFileSync(schemaPath, "utf8");
    await client.query(schema);
    await enableTimescaleIfAvailable(client);
    console.log("Database setup complete.");
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
