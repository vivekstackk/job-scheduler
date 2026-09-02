import Fastify from "fastify";
import cors from "@fastify/cors";

import { JobStore } from "./jobStore";
import { JobRunStore } from "./jobRunStore";
import { CreateJobInput } from "./types";
import { UpdateJobInput } from "./jobStore";
import { registerApiKeyAuth } from "./auth";

// A comma-separated ALLOWED_ORIGINS locks the API to known frontends. Left
// unset it reflects any origin, which keeps local development and the tests
// working — but means a deployed API should always set it.
function corsOrigin(): true | string[] {
  const configured = process.env.ALLOWED_ORIGINS?.trim();
  if (!configured) return true;

  return configured
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function buildServer() {
  const app = Fastify({
    logger: true,
  });

  const store = new JobStore();
  const runStore = new JobRunStore();

  // Allow the deployed frontend to communicate with this API
  app.register(cors, {
    origin: corsOrigin(),
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-api-key"],
  });

  // Reads stay public; POST/PUT/DELETE require x-api-key once API_KEY is set.
  registerApiKeyAuth(app);

  // Health check
  app.get("/health", async () => {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  });

  // Create job
  app.post<{ Body: CreateJobInput }>("/jobs", async (request, reply) => {
    const job = await store.create(request.body);

    reply.code(201);
    return job;
  });

  // List jobs
  app.get("/jobs", async () => {
    return store.list();
  });

  // Get single job
  app.get<{ Params: { id: string } }>(
    "/jobs/:id",
    async (request, reply) => {
      const job = await store.get(request.params.id);

      if (!job) {
        reply.code(404);
        return { error: "job not found" };
      }

      return job;
    }
  );

  // Get job runs
  app.get<{ Params: { id: string } }>(
    "/jobs/:id/runs",
    async (request, reply) => {
      const job = await store.get(request.params.id);

      if (!job) {
        reply.code(404);
        return { error: "job not found" };
      }

      return runStore.listByJob(request.params.id);
    }
  );

  // Update job
  app.put<{
    Params: { id: string };
    Body: UpdateJobInput;
  }>("/jobs/:id", async (request, reply) => {
    const job = await store.update(
      request.params.id,
      request.body
    );

    if (!job) {
      reply.code(404);
      return { error: "job not found" };
    }

    return job;
  });

  // Delete job
  app.delete<{ Params: { id: string } }>(
    "/jobs/:id",
    async (request, reply) => {
      const deleted = await store.delete(request.params.id);

      if (!deleted) {
        reply.code(404);
        return { error: "job not found" };
      }

      reply.code(204);
      return null;
    }
  );

  return app;
}