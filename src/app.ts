import Fastify, { type FastifyInstance } from "fastify";
import { getTransaction, insertTransaction, type Pool, type TransactionInput } from "./db.js";

const webhookSchema = {
  body: {
    type: "object",
    required: ["transaction_id", "source_account", "destination_account", "amount", "currency"],
    properties: {
      transaction_id: { type: "string", minLength: 1, maxLength: 128 },
      source_account: { type: "string", minLength: 1, maxLength: 128 },
      destination_account: { type: "string", minLength: 1, maxLength: 128 },
      amount: { type: "number", exclusiveMinimum: 0 },
      currency: { type: "string", minLength: 3, maxLength: 3 },
    },
  },
} as const;

export function buildApp(pool: Pool): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  // Health check
  app.get("/", async () => ({
    status: "HEALTHY",
    current_time: new Date().toISOString(),
  }));

  // Webhook: persist + ack. No processing in the request path.
  app.post<{ Body: TransactionInput }>(
    "/v1/webhooks/transactions",
    { schema: webhookSchema },
    async (req, reply) => {
      const created = await insertTransaction(pool, req.body);
      if (!created) {
        req.log.info({ transaction_id: req.body.transaction_id }, "duplicate webhook ignored");
      }
      // Same response for new and duplicate deliveries
      return reply.code(202).send({ status: "ACCEPTED", transaction_id: req.body.transaction_id });
    },
  );

  // Query endpoint (for testing). Spec shows an array with one element.
  app.get<{ Params: { transaction_id: string } }>(
    "/v1/transactions/:transaction_id",
    async (req, reply) => {
      const row = await getTransaction(pool, req.params.transaction_id);
      if (!row) return reply.code(404).send({ error: "Transaction not found" });
      return [
        {
          transaction_id: row.transaction_id,
          source_account: row.source_account,
          destination_account: row.destination_account,
          amount: Number(row.amount),
          currency: row.currency,
          status: row.status,
          created_at: row.created_at.toISOString(),
          processed_at: row.processed_at ? row.processed_at.toISOString() : null,
        },
      ];
    },
  );

  return app;
}
