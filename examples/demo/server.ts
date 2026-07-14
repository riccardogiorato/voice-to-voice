import { createServer } from "node:http";
import { resolve } from "node:path";
import next from "next";
import { createNodeRealtimeAdapter } from "@together/realtime/node";

try {
  process.loadEnvFile(resolve(process.cwd(), "../../.env"));
} catch {}

const [{ realtimeEngine }] = await Promise.all([import("./lib/realtime.js")]);
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const dev = process.env.NODE_ENV !== "production";
const app = next({ dev, dir: process.cwd(), port });
const nextHandler = app.getRequestHandler();
const realtime = createNodeRealtimeAdapter(realtimeEngine);

await app.prepare();

const server = createServer(async (request, response) => {
  if (await realtime.handleRequest(request, response)) return;
  await nextHandler(request, response);
});

realtime.attach(server);
server.listen(port, "0.0.0.0", () => {
  console.log(`Together Realtime demo: http://localhost:${port}`);
});
