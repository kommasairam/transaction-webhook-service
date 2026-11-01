import type { Pool } from "./db.js";

export interface WorkerOptions {
  processingDelayMs: number;
  leaseMs: number;
  pollIntervalMs: number;
  concurrency: number;
  maxAttempts: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Postgres-backed job worker. The `transactions` table is the queue:
 *  - claim: FOR UPDATE SKIP LOCKED + lease (locked_at) so multiple instances never double-claim
 *  - crash recovery: rows with an expired lease are re-claimed
 *  - completion: guarded UPDATE (WHERE status='PROCESSING') so a row is finalised at most once
 */
export class Worker {
  private inFlight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticking = false;

  constructor(
    private pool: Pool,
    private opts: WorkerOptions,
    private log: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void } = console,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      await this.tick();
      if (this.running) this.timer = setTimeout(loop, this.opts.pollIntervalMs);
    };
    void loop();
  }

  /** Stop polling and wait for in-flight work to finish (up to timeoutMs). */
  async stop(timeoutMs = 5_000): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight.size > 0 && Date.now() < deadline) await sleep(50);
    // Anything still in flight keeps its lease and is recovered after it expires.
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const free = this.opts.concurrency - this.inFlight.size;
      if (free <= 0) return;
      const ids = await this.claim(free);
      for (const id of ids) {
        this.inFlight.add(id);
        void this.process(id).finally(() => this.inFlight.delete(id));
      }
    } catch (err) {
      this.log.error({ err }, "worker tick failed");
    } finally {
      this.ticking = false;
    }
  }

  private async claim(limit: number): Promise<string[]> {
    const res = await this.pool.query<{ transaction_id: string }>(
      `UPDATE transactions
          SET locked_at = now(), attempts = attempts + 1
        WHERE transaction_id IN (
          SELECT transaction_id FROM transactions
           WHERE status = 'PROCESSING'
             AND (locked_at IS NULL OR locked_at < now() - make_interval(secs => $1::float8))
           ORDER BY created_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
        RETURNING transaction_id`,
      [this.opts.leaseMs / 1000, limit],
    );
    return res.rows.map((r) => r.transaction_id);
  }

  private async process(id: string): Promise<void> {
    try {
      // Simulated external API call
      await sleep(this.opts.processingDelayMs);
      await this.pool.query(
        `UPDATE transactions
            SET status = 'PROCESSED', processed_at = now(), locked_at = NULL
          WHERE transaction_id = $1 AND status = 'PROCESSING'`,
        [id],
      );
      this.log.info({ transaction_id: id }, "transaction processed");
    } catch (err) {
      this.log.error({ err, transaction_id: id }, "processing failed");
      try {
        // Release the lock for retry, or give up after maxAttempts
        await this.pool.query(
          `UPDATE transactions
              SET locked_at = NULL,
                  status = CASE WHEN attempts >= $2 THEN 'FAILED' ELSE status END
            WHERE transaction_id = $1 AND status = 'PROCESSING'`,
          [id, this.opts.maxAttempts],
        );
      } catch (err2) {
        // DB unreachable: lease expiry will make the row claimable again
        this.log.error({ err: err2, transaction_id: id }, "failed to release lock");
      }
    }
  }
}
