import { buildServer } from "../src/server";

describe("job scheduler API", () => {
  it("creates a job via POST /jobs", async () => {
    const app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: {
        name: "daily-report",
        cronExpression: "0 9 * * *",
        handlerType: "send-report",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.id).toBeDefined();
    expect(body.status).toBe("active");
  });

  it("lists jobs via GET /jobs", async () => {
    const app = buildServer();

    await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { name: "a", cronExpression: "0 9 * * *", handlerType: "a" },
    });

    const response = await app.inject({ method: "GET", url: "/jobs" });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body).toHaveLength(1);
  });

  it("returns 404 for a job that does not exist", async () => {
    const app = buildServer();

    const response = await app.inject({ method: "GET", url: "/jobs/does-not-exist" });

    expect(response.statusCode).toBe(404);
  });

  it("updates a job via PUT /jobs/:id", async () => {
    const app = buildServer();

    const created = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { name: "a", cronExpression: "0 9 * * *", handlerType: "a" },
    });
    const job = JSON.parse(created.body);

    const response = await app.inject({
      method: "PUT",
      url: `/jobs/${job.id}`,
      payload: { status: "paused" },
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.status).toBe("paused");
  });

  it("deletes a job via DELETE /jobs/:id", async () => {
    const app = buildServer();

    const created = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { name: "a", cronExpression: "0 9 * * *", handlerType: "a" },
    });
    const job = JSON.parse(created.body);

    const response = await app.inject({ method: "DELETE", url: `/jobs/${job.id}` });

    expect(response.statusCode).toBe(204);
  });
});
