import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { decodeLogBuffer, parseTsvLines } from "../../src/shared/log-parser.mjs";

describe("parseTsvLines", () => {
  const SAMPLE = [
    "#Version: 1.0",
    "#Fields: date\ttime\tc-ip\tcs-method\tcs-uri-stem\tsc-status\tcs(User-Agent)",
    "2026-04-24\t06:00:00\t1.2.3.4\tGET\t/blog/hello\t200\tMozilla/5.0",
    "2026-04-24\t06:01:00\t1.2.3.5\tGET\t/blog/world\t200\tMozilla/5.0",
  ].join("\n");

  it("parses two data lines", () => {
    expect(parseTsvLines(SAMPLE)).toHaveLength(2);
  });

  it("maps field names correctly", () => {
    const [entry] = parseTsvLines(SAMPLE);
    expect(entry["c-ip"]).toBe("1.2.3.4");
    expect(entry["cs-uri-stem"]).toBe("/blog/hello");
    expect(entry["sc-status"]).toBe("200");
    expect(entry["date"]).toBe("2026-04-24");
    expect(entry["cs(User-Agent)"]).toBe("Mozilla/5.0");
  });

  it("skips comment and header lines", () => {
    expect(parseTsvLines("#Version: 1.0\n#Fields: date\ttime\n")).toHaveLength(0);
  });

  it("returns empty array when no #Fields header", () => {
    expect(parseTsvLines("1.2.3.4\tGET\t/blog/post\t200")).toHaveLength(0);
  });

  it("skips lines with wrong column count", () => {
    const bad = [
      "#Fields: date\tc-ip",
      "2026-04-24\t1.2.3.4\textra-column",
    ].join("\n");
    expect(parseTsvLines(bad)).toHaveLength(0);
  });
});

describe("decodeLogBuffer", () => {
  it("decompresses gzip content", () => {
    expect(decodeLogBuffer(gzipSync(Buffer.from("hello\tworld")))).toBe("hello\tworld");
  });
  it("returns plain text unchanged", () => {
    expect(decodeLogBuffer(Buffer.from("hello"))).toBe("hello");
  });
});
