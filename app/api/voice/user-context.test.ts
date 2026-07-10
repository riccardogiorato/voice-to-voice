import { expect, test } from "bun:test";
import { userContextFromRequest, validTimeZone } from "./user-context";

test("reads Vercel location context from the websocket request", () => {
  const request = new Request("https://example.com/api/voice", {
    headers: {
      "x-vercel-ip-timezone": "Europe/Rome",
      "x-vercel-ip-city": "Reggio%20Emilia",
      "x-vercel-ip-country": "IT",
      "x-vercel-ip-country-region": "45",
    },
  });

  expect(userContextFromRequest(request)).toEqual({
    timeZone: "Europe/Rome",
    city: "Reggio Emilia",
    country: "IT",
    countryRegion: "45",
  });
});

test("ignores missing or invalid location context", () => {
  const request = new Request("http://localhost/api/voice", {
    headers: { "x-vercel-ip-timezone": "not/a-time-zone" },
  });

  expect(userContextFromRequest(request)).toEqual({});
  expect(validTimeZone("UTC")).toBe("UTC");
  expect(validTimeZone("not/a-time-zone")).toBeUndefined();
});
