import { buildServer } from "./server";

const app = buildServer();

app.listen({ port: 3000 }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log(`Job scheduler API running at ${address}`);
});
