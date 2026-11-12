import { describe, expect, test } from "bun:test";
import { superResolutionAvailable } from "./mobileSuperResolution";

describe("super resolution availability", () => {
  test("reports unavailable where there is no native module (Bun/web)", () => {
    expect(superResolutionAvailable()).toBe(false);
  });
});
