import { describe, it, expect, vi, beforeEach } from "vitest";
import { gzipSync } from "node:zlib";

const { mockS3Send, mockCFSend, mockPaginator } = vi.hoisted(() => ({
  mockS3Send: vi.fn(),
  mockCFSend: vi.fn(),
  mockPaginator: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(function () { return { send: mockS3Send }; }),
  GetObjectCommand: vi.fn(function (x) { return x; }),
  PutObjectCommand: vi.fn(function (x) { return x; }),
  paginateListObjectsV2: mockPaginator,
}));

vi.mock("@aws-sdk/client-cloudfront", () => ({
  CloudFrontClient: vi.fn(function () { return { send: mockCFSend }; }),
  CreateInvalidationCommand: vi.fn(function (x) { return x; }),
}));

import { handler } from "../src/handler.mjs";

const TODAY = new Date().toISOString().slice(0, 10);
const VALID_KEY = `logs/example.${TODAY}-00.gz`;

const LOG_CONTENT = [
  "#Version: 1.0",
  "#Fields: date\ttime\tc-ip\tcs-method\tcs-uri-stem\tsc-status\tcs(User-Agent)\tx-edge-result-type",
  `${TODAY}\t06:00:00\t1.2.3.4\tGET\t/blog/hello/\t200\tMozilla/5.0\tHit`,
  `${TODAY}\t06:00:01\t1.2.3.4\tGET\t/css/main.css\t200\tMozilla/5.0\tHit`,
  `${TODAY}\t06:01:00\t1.2.3.5\tGET\t/blog/hello/\t200\tMozilla/5.0\tHit`,
  `${TODAY}\t06:01:01\t1.2.3.5\tGET\t/bootstrap.bundle.min.js\t200\tMozilla/5.0\tHit`,
  `${TODAY}\t06:02:00\t1.2.3.6\tGET\t/about/\t200\tMozilla/5.0\tHit`,
  `${TODAY}\t06:03:00\t-\tGET\t/blog/hello/\t200\tMozilla/5.0\tHit`,
  `${TODAY}\t06:04:00\t1.2.3.7\tGET\t/blog/hello/\t200\tGooglebot/2.1\tHit`,
  `${TODAY}\t06:05:00\t1.2.3.8\tGET\t/blog/hello/\t200\tMozilla/5.0\tFiltered`,
].join("\n");

const makeGzipBody = content => ({
  Body: { transformToByteArray: () => Promise.resolve(gzipSync(Buffer.from(content))) },
});
const makeRawBody = content => ({
  Body: { transformToByteArray: () => Promise.resolve(Buffer.from(content)) },
});
const paginator = pages => (async function* () { for (const p of pages) yield p; })();

beforeEach(() => {
  mockS3Send.mockReset();
  mockCFSend.mockReset();
  mockPaginator.mockReset();
  process.env.LOGS_BUCKET = "logs-bucket";
  process.env.LOGS_PREFIX = "logs/";
  process.env.WEBSITE_BUCKET = "website-bucket";
  process.env.DISTRIBUTION_ID = "DIST123";
});

describe("handler", () => {
  it("processes gzip log files and returns a summary", async () => {
    mockPaginator.mockReturnValue(paginator([{ Contents: [{ Key: VALID_KEY }] }]));
    mockS3Send.mockResolvedValueOnce(makeGzipBody(LOG_CONTENT)).mockResolvedValue({});
    mockCFSend.mockResolvedValue({});

    const result = await handler({}, {});

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.filesProcessed).toBe(1);
    expect(body.totalUniqueVisitors).toBe(2);
    expect(body.totalPagesTracked).toBe(1);
    expect(body.topPage).toEqual(["/blog/hello/", 2]);
  });

  it("falls back to raw text when gunzip fails", async () => {
    mockPaginator.mockReturnValue(paginator([{ Contents: [{ Key: VALID_KEY }] }]));
    mockS3Send.mockResolvedValueOnce(makeRawBody(LOG_CONTENT)).mockResolvedValue({});
    mockCFSend.mockResolvedValue({});

    const result = await handler({}, {});

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).filesProcessed).toBe(1);
  });

  it("skips files outside the 30-day window", async () => {
    mockPaginator.mockReturnValue(paginator([
      { Contents: [{ Key: "logs/old.2020-01-01-00.gz" }, { Key: "logs/future.2099-01-01-00.gz" }] },
    ]));
    mockS3Send.mockResolvedValue({});
    mockCFSend.mockResolvedValue({});

    const result = await handler({}, {});

    expect(JSON.parse(result.body).filesProcessed).toBe(0);
  });

  it("skips keys without a date pattern", async () => {
    mockPaginator.mockReturnValue(paginator([{ Contents: [{ Key: "logs/no-date.gz" }] }]));
    mockS3Send.mockResolvedValue({});
    mockCFSend.mockResolvedValue({});

    const result = await handler({}, {});

    expect(JSON.parse(result.body).filesProcessed).toBe(0);
  });

  it("handles S3 pages with no Contents field", async () => {
    mockPaginator.mockReturnValue(paginator([{}]));
    mockS3Send.mockResolvedValue({});
    mockCFSend.mockResolvedValue({});

    const result = await handler({}, {});

    expect(result.statusCode).toBe(200);
  });

  it("logs an error and counts failed files as not processed", async () => {
    mockPaginator.mockReturnValue(paginator([{ Contents: [{ Key: VALID_KEY }] }]));
    mockS3Send.mockRejectedValueOnce(new Error("S3 error")).mockResolvedValue({});
    mockCFSend.mockResolvedValue({});

    const result = await handler({}, {});

    const body = JSON.parse(result.body);
    expect(body.filesProcessed).toBe(0);
  });

  it("returns null topPage and zero daysWithData when no logs are found", async () => {
    mockPaginator.mockReturnValue(paginator([{ Contents: [] }]));
    mockS3Send.mockResolvedValue({});
    mockCFSend.mockResolvedValue({});

    const result = await handler({}, {});

    const body = JSON.parse(result.body);
    expect(body.topPage).toBeNull();
    expect(body.daysWithData).toBe(0);
  });

  it("uses empty string for LOGS_PREFIX when env var is unset", async () => {
    delete process.env.LOGS_PREFIX;
    mockPaginator.mockReturnValue(paginator([{ Contents: [] }]));
    mockS3Send.mockResolvedValue({});
    mockCFSend.mockResolvedValue({});

    const result = await handler({}, {});

    expect(result.statusCode).toBe(200);
  });
});
