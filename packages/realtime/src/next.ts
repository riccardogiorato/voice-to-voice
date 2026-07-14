import { RealtimeEngine } from "./engine.js";
import { extractBrowserClientSecret } from "./token.js";
import { RealtimeProtocolError, type RealtimeSocket } from "./types.js";

export type NextRealtimeAdapterOptions = {
  allowedOrigins?: string[];
};

export function createNextRealtimeHandlers(
  engine: RealtimeEngine,
  options: NextRealtimeAdapterOptions = {},
) {
  const POST = async (request: Request) => {
    try {
      const body = await request.json().catch(() => ({}));
      const result = await engine.createClientSecret(body);
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return errorResponse(error, error instanceof RealtimeProtocolError ? 400 : 500);
    }
  };

  const GET = async (request: Request) => {
    try {
      assertOrigin(request.headers.get("origin"), options.allowedOrigins);
      const url = new URL(request.url);
      if (url.searchParams.has("model") && url.searchParams.get("model") !== "together-realtime") {
        throw new RealtimeProtocolError(
          "The realtime pipeline models are server-controlled; use model=together-realtime.",
          "invalid_request_error",
          "model",
          true,
        );
      }
      const clientSecret = extractBrowserClientSecret(
        request.headers.get("sec-websocket-protocol") ?? undefined,
      );
      engine.authorize(clientSecret);
      const { experimental_upgradeWebSocket } = await import("@vercel/functions");
      return experimental_upgradeWebSocket((socket) => {
        engine.acceptSocket(socket as unknown as RealtimeSocket, clientSecret);
      }, { maxPayload: 1024 * 1024 });
    } catch (error) {
      return errorResponse(error, upgradeStatus(error));
    }
  };

  return { POST, GET };
}

function upgradeStatus(error: unknown) {
  if (!(error instanceof RealtimeProtocolError)) return 500;
  if (error.code === "invalid_api_key" || error.code === "expired_api_key") return 401;
  if (error.code === "invalid_origin") return 403;
  return 400;
}

function assertOrigin(origin: string | null, allowedOrigins: string[] | undefined) {
  if (!allowedOrigins || allowedOrigins.length === 0 || !origin) return;
  if (!allowedOrigins.includes(origin)) {
    throw new RealtimeProtocolError("WebSocket origin is not allowed.", "invalid_origin", "Origin", true);
  }
}

function errorResponse(error: unknown, status: number) {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const protocol = normalized instanceof RealtimeProtocolError ? normalized : undefined;
  return Response.json(
    {
      error: {
        type: protocol?.code === "invalid_request_error" ? "invalid_request_error" : "server_error",
        code: protocol?.code ?? "server_error",
        message: normalized.message,
        param: protocol?.param ?? null,
      },
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
