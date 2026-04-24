import { describe, it, expect } from "vitest";
import { isBot, isPageRequest, parseTsvLines } from "../src/handler.mjs";

describe("isBot", () => {
  it("returns true for empty string", () => expect(isBot("")).toBe(true));
  it("returns true for dash", () => expect(isBot("-")).toBe(true));
  it("returns true for Googlebot", () =>
    expect(isBot("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(true));
  it("returns true for ClaudeBot", () => expect(isBot("ClaudeBot/1.0")).toBe(true));
  it("returns true for curl", () => expect(isBot("curl/7.88.1")).toBe(true));
  it("returns false for Firefox", () =>
    expect(isBot("Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0")).toBe(false));
  it("returns false for Safari", () =>
    expect(isBot("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15")).toBe(false));
});

describe("isPageRequest", () => {
  it("accepts normal page GET 200", () => expect(isPageRequest("/blog/post", "GET", "200")).toBe(true));
  it("accepts 301 redirect", () => expect(isPageRequest("/blog/post", "GET", "301")).toBe(true));
  it("rejects POST", () => expect(isPageRequest("/blog/post", "POST", "200")).toBe(false));
  it("rejects 404", () => expect(isPageRequest("/blog/post", "GET", "404")).toBe(false));
  it("rejects 500", () => expect(isPageRequest("/blog/post", "GET", "500")).toBe(false));
  it("rejects root /", () => expect(isPageRequest("/", "GET", "200")).toBe(false));
  it("rejects /feeds.xml", () => expect(isPageRequest("/feeds.xml", "GET", "200")).toBe(false));
  it("rejects /rss.xml", () => expect(isPageRequest("/rss.xml", "GET", "200")).toBe(false));
  it("rejects .css", () => expect(isPageRequest("/style.css", "GET", "200")).toBe(false));
  it("rejects .js", () => expect(isPageRequest("/app.js", "GET", "200")).toBe(false));
  it("rejects .png", () => expect(isPageRequest("/logo.png", "GET", "200")).toBe(false));
  it("rejects wp-login", () => expect(isPageRequest("/wp-login.php", "GET", "200")).toBe(false));
  it("rejects .env probe", () => expect(isPageRequest("/.env", "GET", "200")).toBe(false));
});

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
