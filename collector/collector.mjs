import { loadLocalEnv } from "../lib/env.js";

loadLocalEnv();

const { closePool } = await import("../lib/db.js");
const { runCollector, shutdown } = await import("./runtime.mjs");

process.on("SIGINT", () => {
  shutdown("SIGINT").finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM").finally(() => process.exit(0));
});

runCollector()
  .catch(async (error) => {
    console.error(error);
    try {
      const { COLLECTOR_NAME } = await import("./config.mjs");
      const { heartbeat } = await import("./store.mjs");
      await heartbeat(COLLECTOR_NAME, "error", null, error.message || String(error));
    } finally {
      await closePool();
    }
    process.exit(1);
  })
  .finally(async () => {
    await closePool();
  });
