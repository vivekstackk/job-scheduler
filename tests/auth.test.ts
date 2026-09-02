import { buildServer } from "../src/server";

// Deliberately DB-free: the auth hook runs in onRequest, before any handler
// touches a store, so every case here resolves without Postgres. That makes it
// the one suite that can run anywhere, including in CI before the database
// service is ready.
describe("API key auth", () => {
  const original = process.env.API_KEY;

  afterAll(() => {
    if (original === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = original;
  });

  describe("when API_KEY is set", () => {
    beforeEach(() => {
      process.env.API_KEY = "test-secret-key";
    });

    it("rejects POST /jobs with no key", async () => {
      const app = buildServer();

      const response = await app.inject({
        method: "POST",
        url: "/jobs",
        payload: { name: "a", cronExpression: "0 9 * * *", handlerType: "a" },
      });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body).error).toMatch(/x-api-key/);
    });

    it("rejects POST /jobs with the wrong key", async () => {
      const app = buildServer();

      const response = await app.inject({
        method: "POST",
        url: "/jobs",
        headers: { "x-api-key": "wrong" },
        payload: { name: "a", cronExpression: "0 9 * * *", handlerType: "a" },
      });

      expect(response.statusCode).toBe(401);
    });

    it("rejects a key that only shares a prefix", async () => {
      const app = buildServer();

      const response = await app.inject({
        method: "POST",
        url: "/jobs",
        headers: { "x-api-key": "test-secret-ke" },
        payload: { name: "a", cronExpression: "0 9 * * *", handlerType: "a" },
      });

      expect(response.statusCode).toBe(401);
    });

    it("rejects PUT /jobs/:id with no key", async () => {
      const app = buildServer();

      const response = await app.inject({
        method: "PUT",
        url: "/jobs/some-id",
        payload: { status: "paused" },
      });

      expect(response.statusCode).toBe(401);
    });

    it("rejects DELETE /jobs/:id with no key", async () => {
      const app = buildServer();

      const response = await app.inject({
        method: "DELETE",
        url: "/jobs/some-id",
      });

      expect(response.statusCode).toBe(401);
    });

    it("leaves GET /health open", async () => {
      const app = buildServer();

      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).status).toBe("ok");
    });

    it("leaves reads open — an unknown GET route 404s rather than 401s", async () => {
      const app = buildServer();

      const response = await app.inject({ method: "GET", url: "/not-a-route" });

      expect(response.statusCode).toBe(404);
    });

    it("does not block the CORS preflight for a write", async () => {
      const app = buildServer();

      const response = await app.inject({
        method: "OPTIONS",
        url: "/jobs",
        headers: {
          origin: "http://localhost:5173",
          "access-control-request-method": "POST",
        },
      });

      expect(response.statusCode).not.toBe(401);
      expect(response.headers["access-control-allow-methods"]).toContain(
        "POST"
      );
    });

    it("advertises x-api-key as an allowed header", async () => {
      const app = buildServer();

      const response = await app.inject({
        method: "OPTIONS",
        url: "/jobs",
        headers: {
          origin: "http://localhost:5173",
          "access-control-request-method": "POST",
          "access-control-request-headers": "x-api-key",
        },
      });

      expect(
        String(response.headers["access-control-allow-headers"]).toLowerCase()
      ).toContain("x-api-key");
    });
  });

  describe("when API_KEY is not set", () => {
    beforeEach(() => {
      delete process.env.API_KEY;
    });

    // Backwards compatibility: local development and the existing DB-backed
    // suites POST without a key, so an unset API_KEY has to stay permissive.
    it("allows a write through to the handler", async () => {
      const app = buildServer();

      const response = await app.inject({
        method: "PUT",
        url: "/jobs/some-id",
        payload: { status: "paused" },
      });

      // Reaching the handler is the assertion. Without a database it fails
      // there, which is still proof that auth did not short-circuit it.
      expect(response.statusCode).not.toBe(401);
    });
  });
});
