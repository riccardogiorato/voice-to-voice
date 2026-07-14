import { createNextRealtimeHandlers } from "@together/realtime/next";
import { realtimeEngine } from "@/lib/realtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = createNextRealtimeHandlers(realtimeEngine);
export const POST = handlers.POST;
