const int = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: int("PORT", 3000),
  databaseUrl: process.env.DATABASE_URL ?? "",
  // Simulated external API latency (spec: 30s)
  processingDelayMs: int("PROCESSING_DELAY_MS", 30_000),
  // A claimed row whose lease is older than this is considered abandoned (crashed worker)
  leaseMs: int("LEASE_MS", 120_000),
  pollIntervalMs: int("POLL_INTERVAL_MS", 1_000),
  // Max transactions processed concurrently by one instance
  workerConcurrency: int("WORKER_CONCURRENCY", 200),
  maxAttempts: int("MAX_ATTEMPTS", 5),
};
