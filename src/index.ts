import { buildServer } from "./server";

const app = buildServer();

const port = Number(process.env.PORT || 3000);

app.listen(
  {
    port,
    host: "0.0.0.0",
  },
  (err, address) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }

    console.log(`Job scheduler API running at ${address}`);
  }
);