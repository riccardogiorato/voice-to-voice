import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { RealtimeEngine } from "./engine.js";
import { extractBrowserClientSecret } from "./token.js";
import { RealtimeProtocolError } from "./types.js";

export type NodeRealtimeAdapterOptions = {
  clientSecretPath?: string;
  realtimePath?: string;
  allowedOrigins?: string[];
};

export function createNodeRealtimeAdapter(
  engine: RealtimeEngine,
  options: NodeRealtimeAdapterOptions = {},
) {
  const clientSecretPath = options.clientSecretPath ?? "/api/realtime/client_secrets";
  const realtimePath = options.realtimePath ?? "/api/realtime";
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    handleProtocols(protocols) {
      return protocols.has("realtime") ? "realtime" : false;
    },
  });

  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    const url = requestUrl(request);
    if (url.pathname === clientSecretPath && request.method === "POST") {
      try {
        const body = await readJsonBody(request);
        const secret = await engine.createClientSecret(body);
        json(response, 200, secret);
      } catch (error) {
        const status = error instanceof RealtimeProtocolError ? 400 : 500;
        json(response, status, httpError(error));
      }
      return true;
    }
    if (url.pathname === realtimePath) {
      json(response, 426, {
        error: {
          type: "invalid_request_error",
          code: "websocket_upgrade_required",
          message: "This endpoint requires a WebSocket upgrade.",
          param: null,
        },
      });
      return true;
    }
    return false;
  };

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = requestUrl(request);
    if (url.pathname !== realtimePath) return false;
    try {
      assertOrigin(request.headers.origin, options.allowedOrigins);
      if (url.searchParams.has("model") && url.searchParams.get("model") !== "together-realtime") {
        throw new RealtimeProtocolError(
          "The realtime pipeline models are server-controlled; use model=together-realtime.",
          "invalid_request_error",
          "model",
          true,
        );
      }
      const clientSecret = extractBrowserClientSecret(request.headers["sec-websocket-protocol"]);
      engine.authorize(clientSecret);
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit("connection", webSocket, request);
        engine.acceptSocket(webSocket, clientSecret);
      });
    } catch (error) {
      rejectUpgrade(socket, upgradeStatus(error), normalizeError(error).message);
    }
    return true;
  };

  const attach = (server: Server) => {
    server.on("upgrade", handleUpgrade);
    return () => server.off("upgrade", handleUpgrade);
  };

  return { handleRequest, handleUpgrade, attach };
}

function upgradeStatus(error: unknown) {
  if (!(error instanceof RealtimeProtocolError)) return 400;
  if (error.code === "invalid_api_key" || error.code === "expired_api_key") return 401;
  if (error.code === "invalid_origin") return 403;
  return 400;
}

function requestUrl(request: IncomingMessage) {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += value.length;
    if (length > 64 * 1024) throw new RealtimeProtocolError("Request body is too large.", "invalid_request_error");
    chunks.push(value);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RealtimeProtocolError("Request body must be valid JSON.", "invalid_request_error");
  }
}

function assertOrigin(origin: string | undefined, allowedOrigins: string[] | undefined) {
  if (!allowedOrigins || allowedOrigins.length === 0 || !origin) return;
  if (!allowedOrigins.includes(origin)) {
    throw new RealtimeProtocolError("WebSocket origin is not allowed.", "invalid_origin", "Origin", true);
  }
}

function rejectUpgrade(socket: Duplex, status: number, message: string) {
  const label = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Bad Request";
  const body = JSON.stringify({ error: { message } });
  socket.end(
    `HTTP/1.1 ${status} ${label}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}

function httpError(error: unknown) {
  const value = normalizeError(error);
  const protocol = value instanceof RealtimeProtocolError ? value : undefined;
  return {
    error: {
      type: protocol?.code === "invalid_request_error" ? "invalid_request_error" : "server_error",
      code: protocol?.code ?? "server_error",
      message: value.message,
      param: protocol?.param ?? null,
    },
  };
}

function normalizeError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
