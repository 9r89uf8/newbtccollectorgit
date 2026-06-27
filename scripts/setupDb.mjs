import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadLocalEnv } from "../lib/env.js";

loadLocalEnv();
const { closePool, getPool, hasDatabaseConfig } = await import("../lib/db.js");

const schemaPath = resolve(process.cwd(), "db", "schema.sql");

async function enableTimescaleIfAvailable(client) {
  try {
    await client.query("create extension if not exists timescaledb");
    await client.query(
      "select create_hypertable('price_samples', 'scheduled_at', if_not_exists => true)"
    );
    console.log("TimescaleDB enabled for price_samples.");
  } catch (error) {
    console.log("TimescaleDB not enabled. Core PostgreSQL schema is ready.");
    console.log(`Reason: ${error.message}`);
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


