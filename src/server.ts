import Fastify from "fastify";
import { JobStore } from "./jobStore";
import { CreateJobInput } from "./types";
import { UpdateJobInput } from "./jobStore";

export function buildServer() {
  const app = Fastify();
  const store = new JobStore();

  app.post<{ Body: CreateJobInput }>("/jobs", async (request, reply) => {
    const job = store.create(request.body);
    reply.code(201);
    return job;
  });

  app.get("/jobs", async () => {
    return store.list();
  });

  app.get<{ Params: { id: string } }>("/jobs/:id", async (request, reply) => {
    const job = store.get(request.params.id);
    if (!job) {
      reply.code(404);
      return { error: "job not found" };
    }
    return job;
  });

  app.put<{ Params: { id: string }; Body: UpdateJobInput }>("/jobs/:id", async (request, reply) => {
    const job = store.update(request.params.id, request.body);
    if (!job) {
      reply.code(404);
      return { error: "job not found" };
    }
    return job;
  });

  app.delete<{ Params: { id: string } }>("/jobs/:id", async (request, reply) => {
    const deleted = store.delete(request.params.id);
    if (!deleted) {
      reply.code(404);
      return { error: "job not found" };
    }
    reply.code(204);
    return null;
  });

  return app;
}
