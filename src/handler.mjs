import { S3Client, GetObjectCommand, PutObjectCommand, paginateListObjectsV2 } from "@aws-sdk/client-s3";
import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import { gunzipSync } from "node:zlib";

const s3 = new S3Client({});
const cf = new CloudFrontClient({});

const LOGS_BUCKET = process.env.LOGS_BUCKET;
const LOGS_PREFIX = process.env.LOGS_PREFIX ?? "";
const WEBSITE_BUCKET = process.env.WEBSITE_BUCKET;
const DISTRIBUTION_ID = process.env.DISTRIBUTION_ID;
const OUTPUT_PREFIX = "about/data";
const DAYS = 30;
const TOP_PAGES = 15;

const BOT_RES = [
  /bot|crawl|spider|feedly|feeder|slurp|semrush|ahrefs|python|curl|wget|Go-http|HeadlessChrome|Googlebot|bingbot/i,
  /YandexBot|Bytespider|DotBot|MJ12bot|PetalBot|GPTBot|ClaudeBot|CCBot|facebookexternalhit|Twitterbot|LinkedInBot|DataForSeoBot|Applebot|archive\.org|Sogou/i,
  /Baiduspider|ia_archiver|Uptimebot|monitoring|pingdom|StatusCake|PTST|OWLer|LinuxGetUrl|ChatGPT|GoogleA|Firebase|NotebookLM|Meta-External|Perplexity/i,
  /Kentik|Chronicle|Kokot|La-nazanin|tracker|UptimeKuma|anthropic-ai|AutoRAG|bigsur|Censys|cohere-ai|Cotoyogi|Devin|Extended|GoogleOther/i,
  /img2|laion|LAION|LCC|Manus|Meta-ExternalFetcher|meta-webindexer|Amzn|BuyForMe|Anomura|amazon-kendra|Gemini-Deep|Gemini-CLI|Agent|Awario/i,
];

const PATH_EXCLUDE_RE =
  /\.(php|asp|aspx|cgi)$|wp-|xmlrpc|wp-login|\.env|\.git|\/admin|\/login|phpmyadmin/i;

const ASSET_RE =
  /\.(css|js|png|jpg|jpeg|gif|svg|ico|webp|webm|avif|woff|woff2|ttf|eot|map|xml|json|txt|gz|zip)$/i;

const DATE_IN_KEY_RE = /\.(\d{4}-\d{2}-\d{2})-\d{2}\./;

const NON_VISIT_PATHS = new Set(["/", "/feeds.xml", "/rss.xml"]);

export function isBot(userAgent) {
  if (!userAgent || userAgent === "-") return true;
  const ua = decodeURIComponent(userAgent);
  return BOT_RES.some(re => re.test(ua));
}

export function isPageRequest(uri, method, status) {
  if (method !== "GET") return false;
  if (!status.startsWith("2") && !status.startsWith("3")) return false;
  if (NON_VISIT_PATHS.has(uri)) return false;
  if (PATH_EXCLUDE_RE.test(uri)) return false;
  if (ASSET_RE.test(uri)) return false;
  return true;
}

export function parseTsvLines(content) {
  const entries = [];
  let fields = null;
  for (const line of content.split("\n")) {
    if (!line) continue;
    if (line.startsWith("#Fields:")) {
      fields = line.slice(8).trim().split("\t");
      continue;
    }
    if (line.startsWith("#")) continue;
    if (!fields) continue;
    const parts = line.split("\t");
    if (parts.length !== fields.length) continue;
    const obj = {};
    for (let i = 0; i < fields.length; i++) obj[fields[i]] = parts[i];
    entries.push(obj);
  }
  return entries;
}

async function processLogFile(key, dailyVisitors, pageViews) {
  const resp = await s3.send(new GetObjectCommand({ Bucket: LOGS_BUCKET, Key: key }));
  const raw = Buffer.from(await resp.Body.transformToByteArray());

  let content;
  try {
    content = gunzipSync(raw).toString("utf-8");
  } catch {
    content = raw.toString("utf-8");
  }

  for (const entry of parseTsvLines(content)) {
    const userAgent = entry["cs(User-Agent)"] ?? "";
    const uri = entry["cs-uri-stem"] ?? "";
    const method = entry["cs-method"] ?? "";
    const status = entry["sc-status"] ?? "";
    const ip = entry["c-ip"] ?? "";
    const date = entry["date"] ?? "";

    if (isBot(userAgent)) continue;
    if (!isPageRequest(uri, method, status)) continue;
    if (!ip || ip === "-") continue;

    if (!dailyVisitors.has(date)) dailyVisitors.set(date, new Set());
    dailyVisitors.get(date).add(ip);
    pageViews.set(uri, (pageViews.get(uri) ?? 0) + 1);
  }
}

export async function handler(_event, _context) {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const startDate = new Date(now);
  startDate.setUTCDate(startDate.getUTCDate() - DAYS);
  const startDateStr = startDate.toISOString().slice(0, 10);

  const keys = [];
  const paginator = paginateListObjectsV2({ client: s3 }, { Bucket: LOGS_BUCKET, Prefix: LOGS_PREFIX });
  for await (const page of paginator) {
    for (const obj of page.Contents ?? []) {
      const match = DATE_IN_KEY_RE.exec(obj.Key);
      if (!match) continue;
      const fileDate = match[1];
      if (fileDate < startDateStr || fileDate > todayStr) continue;
      keys.push(obj.Key);
    }
  }

  const dailyVisitors = new Map();
  const pageViews = new Map();

  let filesProcessed = 0;
  const results = await Promise.allSettled(keys.map(k => processLogFile(k, dailyVisitors, pageViews)));
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "fulfilled") {
      filesProcessed++;
    } else {
      console.error(`Error processing ${keys[i]}: ${results[i].reason}`);
    }
  }
  console.log(`Processed ${filesProcessed} log files`);

  const allDates = [];
  const d = new Date(startDate);
  while (d.toISOString().slice(0, 10) <= todayStr) {
    allDates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }

  const generated = now.toISOString();
  const visitorsJson = {
    generated,
    labels: allDates,
    values: allDates.map(ds => dailyVisitors.get(ds)?.size ?? 0),
  };

  const sorted = [...pageViews.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_PAGES);
  const pagesJson = {
    generated,
    labels: sorted.map(p => p[0]),
    values: sorted.map(p => p[1]),
  };

  for (const { name, data } of [{ name: "visitors.json", data: visitorsJson }, { name: "pages.json", data: pagesJson }]) {
    await s3.send(new PutObjectCommand({
      Bucket: WEBSITE_BUCKET,
      Key: `${OUTPUT_PREFIX}/${name}`,
      Body: JSON.stringify(data),
      ContentType: "application/json",
      CacheControl: "max-age=86400",
      ACL: "public-read",
    }));
  }

  await cf.send(new CreateInvalidationCommand({
    DistributionId: DISTRIBUTION_ID,
    InvalidationBatch: {
      Paths: {
        Quantity: 2,
        Items: [`/${OUTPUT_PREFIX}/visitors.json`, `/${OUTPUT_PREFIX}/pages.json`],
      },
      CallerReference: `analytics-${now.toISOString().replace(/\D/g, "").slice(0, 14)}`,
    },
  }));

  const summary = {
    filesProcessed,
    daysWithData: allDates.filter(ds => dailyVisitors.has(ds)).length,
    totalUniqueVisitors: [...dailyVisitors.values()].reduce((sum, s) => sum + s.size, 0),
    totalPagesTracked: pageViews.size,
    topPage: sorted[0] ?? null,
  };
  console.log(JSON.stringify(summary));
  return { statusCode: 200, body: JSON.stringify(summary) };
}
