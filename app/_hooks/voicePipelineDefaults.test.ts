import { expect, test } from "bun:test";
import { parseVoicePipeline } from "@/app/_lib/voice-pipeline";

test("defaults missing and unknown voice pipeline values to Inkling", () => {
  expect(parseVoicePipeline(undefined)).toBe("inkling");
  expect(parseVoicePipeline(null)).toBe("inkling");
  expect(parseVoicePipeline("unknown")).toBe("inkling");
});

test("keeps the dormant classic pipeline addressable explicitly", () => {
  expect(parseVoicePipeline("classic")).toBe("classic");
  expect(parseVoicePipeline("inkling")).toBe("inkling");
});
