import pg from "pg";
const { Pool } = pg;

let pool;

export function getDatabaseUrl() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
}

export function hasDatabaseConfig() {
  return Boolean(getDatabaseUrl());
}

function getSslConfig() {
  const value = String(process.env.PGSSL || "").toLowerCase();
  if (value === "true" || value === "1" || value === "require") {
    return { rejectUnauthorized: false };
  }
  return false;
}

export function getPool() {
  const connectionString = getDatabaseUrl();
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  if (!pool) {
    pool = new Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX || 5),
      ssl: getSslConfig(),
    });
  }

  return pool;
}

export async function query(text, params = []) {
  return getPool().query(text, params);
}

export async function closePool() {
  if (!pool) return;
  await pool.end();
  pool = undefined;
}

