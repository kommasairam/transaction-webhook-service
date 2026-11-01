import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { createPool, migrate, type Pool } from "../src/db.js";
import { Worker } from "../src/worker.js";

// Integration tests need a real Postgres: DATABASE_URL=... npm test
const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

const payload = () => ({
  transaction_id: `txn_${randomUUID()}`,
  source_account: "acc_user_789",
  destination_account: "acc_merchant_456",
  amount: 1500,
  currency: "INR",
});

d("webhook service", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  let worker: Worker;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    pool = createPool(url!);
    await migrate(pool);
    app = buildApp(pool);
    await app.ready();
    // Short delay so tests run quickly; production default is 30s
    worker = new Worker(
      pool,
      { processingDelayMs: 1_000, leaseMs: 60_000, pollIntervalMs: 200, concurrency: 500, maxAttempts: 3 },
      { info: () => {}, error: console.error },
    );
    worker.start();
  });

  afterAll(async () => {
    await worker.stop();
    await app.close();
    await pool.end();
  });

  const post = (body: unknown) =>
    app.inject({ method: "POST", url: "/v1/webhooks/transactions", payload: body as object });
  const get = (id: string) => app.inject({ method: "GET", url: `/v1/transactions/${id}` });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("health check", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("HEALTHY");
    expect(new Date(res.json().current_time).toString()).not.toBe("Invalid Date");
  });

  it("returns 202 and processes after the delay", async () => {
    const p = payload();
    const res = await post(p);
    expect(res.statusCode).toBe(202);

    const [before] = (await get(p.transaction_id)).json();
    expect(before.status).toBe("PROCESSING");
    expect(before.processed_at).toBeNull();

    await wait(2_500);
    const [after] = (await get(p.transaction_id)).json();
    expect(after.status).toBe("PROCESSED");
    expect(after.processed_at).not.toBeNull();
  });

  it("is idempotent under concurrent duplicates", async () => {
    const p = payload();
    const results = await Promise.all(Array.from({ length: 10 }, () => post(p)));
    expect(results.every((r) => r.statusCode === 202)).toBe(true);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM transactions WHERE transaction_id=$1", [
      p.transaction_id,
    ]);
    expect(rows[0].n).toBe(1);
  });

  it("responds quickly under load", async () => {
    const times = await Promise.all(
      Array.from({ length: 100 }, async () => {
        const t = performance.now();
        const r = await post(payload());
        expect(r.statusCode).toBe(202);
        return performance.now() - t;
      }),
    );
    expect(Math.max(...times)).toBeLessThan(500);
  });

  it("recovers a row abandoned by a crashed worker (expired lease)", async () => {
    const p = payload();
    await post(p);
    await pool.query(
      "UPDATE transactions SET locked_at = now() - interval '10 minutes' WHERE transaction_id=$1",
      [p.transaction_id],
    );
    await wait(2_500);
    const [row] = (await get(p.transaction_id)).json();
    expect(row.status).toBe("PROCESSED");
  });

  it("validates input and 404s unknown ids", async () => {
    expect((await post({ transaction_id: "x" })).statusCode).toBe(400);
    expect((await get("txn_does_not_exist")).statusCode).toBe(404);
  });
});
