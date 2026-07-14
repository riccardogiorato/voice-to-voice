import { randomBytes } from "node:crypto";

export function realtimeId(prefix: string) {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}
