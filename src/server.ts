import { buildApp } from "./app.js";
import { config } from "./config.js";
import { createPool, migrate } from "./db.js";
import { Worker } from "./worker.js";

async function main() {
  const pool = createPool(config.databaseUrl);
  await migrate(pool);

  const app = buildApp(pool);
  const worker = new Worker(
    pool,
    {
      processingDelayMs: config.processingDelayMs,
      leaseMs: config.leaseMs,
      pollIntervalMs: config.pollIntervalMs,
      concurrency: config.workerConcurrency,
      maxAttempts: config.maxAttempts,
    },
    app.log as never,
  );

  await app.listen({ port: config.port, host: "0.0.0.0" });
  worker.start();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await worker.stop();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
