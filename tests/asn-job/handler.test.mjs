import { describe, it, expect } from "vitest";
import { handler } from "../../src/asn-job/handler.mjs";

describe("asn-job handler", () => {
  it("is a placeholder that reports not implemented", async () => {
    expect((await handler({}, {})).statusCode).toBe(501);
  });
});
