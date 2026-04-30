import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

const app = Fastify({ logger: true });

app.get("/healthz", async (_request: FastifyRequest, reply: FastifyReply) => {
  // TODO(spec §11.2): include Postgres connectivity status.
  reply.code(200).send({ ok: true, db: "placeholder" });
});

app.post("/api/judge/ticket", async (_request: FastifyRequest, reply: FastifyReply) => {
  // TODO(spec §8.1): verify CF Access JWT and mint single-use WebSocket ticket.
  reply.code(501).send({ error: "Not implemented" });
});

app.get("/", async (_request: FastifyRequest, reply: FastifyReply) => {
  reply.send({ service: "tca-timer-server", status: "scaffold" });
});

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

app
  .listen({ port, host })
  .then(() => app.log.info(`Server scaffold listening on ${host}:${port}`))
  .catch((error) => {
    app.log.error(error, "Failed to start server scaffold");
    process.exit(1);
  });
