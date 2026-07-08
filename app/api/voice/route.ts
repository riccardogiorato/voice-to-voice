import { experimental_upgradeWebSocket } from "@vercel/functions";
import { VoiceSession } from "./voice-session";
import { isAllowedOrigin } from "./voice-utils";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!isAllowedOrigin(request)) {
    return new Response("Forbidden", { status: 403 });
  }

  return experimental_upgradeWebSocket((client) => {
    const session = new VoiceSession(client);
    session.start();
  });
}
