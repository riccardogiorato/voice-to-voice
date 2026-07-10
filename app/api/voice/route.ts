import { experimental_upgradeWebSocket } from "@vercel/functions";
import { VoiceSession } from "./voice-session";
import { isAllowedOrigin } from "./voice-utils";

export const runtime = "nodejs";
export const maxDuration = 660;
const VOICE_SOCKET_MAX_PAYLOAD_BYTES = 1024 * 1024;

export async function GET(request: Request) {
  if (!isAllowedOrigin(request)) {
    return new Response("Forbidden", { status: 403 });
  }

  return experimental_upgradeWebSocket(
    (client) => {
      const session = new VoiceSession(client);
      session.start();
    },
    { maxPayload: VOICE_SOCKET_MAX_PAYLOAD_BYTES },
  );
}
