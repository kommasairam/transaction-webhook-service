import pg from "pg";

export type Pool = pg.Pool;

export function createPool(databaseUrl: string): Pool {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

// Idempotent schema setup, safe to run on every boot.
export async function migrate(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      transaction_id       TEXT PRIMARY KEY,
      source_account       TEXT NOT NULL,
      destination_account  TEXT NOT NULL,
      amount               NUMERIC(18,2) NOT NULL,
      currency             TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'PROCESSING'
                           CHECK (status IN ('PROCESSING','PROCESSED','FAILED')),
      attempts             INT NOT NULL DEFAULT 0,
      locked_at            TIMESTAMPTZ,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      processed_at         TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_transactions_pending
      ON transactions (status, created_at) WHERE status = 'PROCESSING';
  `);
}

export interface TransactionInput {
  transaction_id: string;
  source_account: string;
  destination_account: string;
  amount: number;
  currency: string;
}

// Returns true if a new row was inserted, false if it was a duplicate.
export async function insertTransaction(pool: Pool, t: TransactionInput): Promise<boolean> {
  const res = await pool.query(
    `INSERT INTO transactions (transaction_id, source_account, destination_account, amount, currency)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (transaction_id) DO NOTHING`,
    [t.transaction_id, t.source_account, t.destination_account, t.amount, t.currency],
  );
  return (res.rowCount ?? 0) === 1;
}

export interface TransactionRow {
  transaction_id: string;
  source_account: string;
  destination_account: string;
  amount: string;
  currency: string;
  status: "PROCESSING" | "PROCESSED" | "FAILED";
  created_at: Date;
  processed_at: Date | null;
}

export async function getTransaction(pool: Pool, id: string): Promise<TransactionRow | null> {
  const res = await pool.query<TransactionRow>(
    `SELECT transaction_id, source_account, destination_account, amount, currency,
            status, created_at, processed_at
     FROM transactions WHERE transaction_id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}
