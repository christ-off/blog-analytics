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
const EVIDENCE_WINDOW_MS = 60 * 60 * 1000; // ±1 hour

const BOT_RES = [
  /bot|crawl|spider|feedly|feeder|slurp|semrush|ahrefs|python|curl|wget|okhttp|Go-http|HeadlessChrome|Googlebot|bingbot/i,
  /Yandex|Bytespider|DotBot|MJ12bot|PetalBot|GPTBot|Claude|CCBot|facebookexternalhit|Twitterbot|LinkedInBot|DataForSeoBot|Applebot|archive\.org|Sogou/i,
  /Baiduspider|ia_archiver|Uptimebot|monitoring|pingdom|StatusCake|PTST|OWLer|LinuxGetUrl|ChatGPT|GoogleA|Firebase|NotebookLM|Meta-External|Perplexity/i,
  /Kentik|Chronicle|Kokot|La-nazanin|tracker|UptimeKuma|anthropic-ai|AutoRAG|bigsur|Censys|cohere-ai|Cotoyogi|Devin|Extended|GoogleOther/i,
  /img2|laion|LAION|LCC|Manus|Meta-ExternalFetcher|meta-webindexer|Amzn|BuyForMe|Anomura|amazon-kendra|Gemini-Deep|Gemini-CLI|Agent|Awario/i,
  /AIWebIndex|kagi|MistralAI|newsai|NovaAct|Observer|omgili|OpenAI|opencode|Operator|Panscient|Poggio|Scrapy|Shap|TerraCotta|Terra Cotta|Trae|YaK/i,
  /sindresorhus|presto|trident|seamus|crios|fxios|pimeyes|builtwith|yasearch|yaapp|greedyhand/i,
  /chrome\/9[0-4]\.\d+|iphone os [1-9]_/i,
  /Feedbin|FreshRSS|Inoreader|NewsBlur|Reeder|newsboat|rss-parser|sfFeedReader|RSS Guard|Gofeed|KrISS|FeedFetcher/i,
  /Mastodon|Akkoma|Catodon|Iceshrimp|Misskey|Friendica|Flus\/|Palo Alto|VisionHeight|GoogleImageProxy|Yumechi|StefansTools/i,
  /Chrome-Lighthouse/i,
];

const PATH_EXCLUDE_RE =
  /\.(php|asp|aspx|cgi)$|wp-|xmlrpc|wp-login|\.env|\.git|\/admin|\/login|phpmyadmin|\/pagefind\//i;

const ASSET_RE =
  /\.(css|js|png|jpg|jpeg|gif|svg|ico|webp|webm|avif|woff|woff2|ttf|eot|map|xml|json|txt|gz|zip)$/i;

const DATE_IN_KEY_RE = /\.(\d{4}-\d{2}-\d{2})-\d{2}\./;

const NON_VISIT_PATHS = new Set(["/", "/feed.xml", "/rss.xml"]);

const CSS_ASSET_PATH = "/css/main.css";
const EVIDENCE_ASSET_PATH = "/assets/svgs/ecrit-par-un-humain.svg";
const TRACKED_ASSET_PATHS = new Set([CSS_ASSET_PATH, EVIDENCE_ASSET_PATH]);

export function isBot(userAgent) {
  if (!userAgent || userAgent === "-") return true;
  const ua = decodeURIComponent(userAgent);
  return BOT_RES.some(re => re.test(ua));
}

export function isPageRequest(uri, method, status) {
  if (method !== "GET") return false;
  if (!status.startsWith("2") && !status.startsWith("3")) return false;
  if (!uri.endsWith("/")) return false;
  if (NON_VISIT_PATHS.has(uri)) return false;
  if (PATH_EXCLUDE_RE.test(uri)) return false;
  if (ASSET_RE.test(uri)) return false;
  return true;
}

export function isFilteredResult(resultType) {
  return resultType === "Error" || resultType === "Filtered";
}

export function isTrackedAsset(uri, method, status) {
  if (method !== "GET") return false;
  if (!status.startsWith("2") && !status.startsWith("3")) return false;
  return TRACKED_ASSET_PATHS.has(uri);
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

async function collectEntries(key) {
  const resp = await s3.send(new GetObjectCommand({ Bucket: LOGS_BUCKET, Key: key }));
  const raw = Buffer.from(await resp.Body.transformToByteArray());

  let content;
  try {
    content = gunzipSync(raw).toString("utf-8");
  } catch {
    content = raw.toString("utf-8");
  }

  const entries = [];
  for (const entry of parseTsvLines(content)) {
    const userAgent = entry["cs(User-Agent)"] ?? "";
    const uri = entry["cs-uri-stem"] ?? "";
    const method = entry["cs-method"] ?? "";
    const status = entry["sc-status"] ?? "";
    const ip = entry["c-ip"] ?? "";
    const date = entry["date"] ?? "";
    const time = entry["time"] ?? "";
    const resultType = entry["x-edge-result-type"] ?? "";

    if (isFilteredResult(resultType)) continue;
    if (isBot(userAgent)) continue;
    if (!ip || ip === "-") continue;

    entries.push({ date, ip, userAgent, uri, method, status, timestamp: parseTimestamp(date, time) });
  }
  return entries;
}

export function parseTimestamp(date, time) {
  return Date.parse(`${date}T${time}Z`);
}

export function hasTimestampWithin(timestamps, target, windowMs) {
  return timestamps.some(ts => Math.abs(ts - target) <= windowMs);
}

function visitorKey(e) {
  return `${e.ip}|${e.userAgent}`;
}

function buildAssetTimestamps(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (!isTrackedAsset(e.uri, e.method, e.status)) continue;
    const key = visitorKey(e);
    let group = groups.get(key);
    if (!group) {
      group = { css: [], evidence: [] };
      groups.set(key, group);
    }
    if (e.uri === CSS_ASSET_PATH) group.css.push(e.timestamp);
    if (e.uri === EVIDENCE_ASSET_PATH) group.evidence.push(e.timestamp);
  }
  return groups;
}

function aggregateVisitorsAndPages(entries, assetGroups) {
  const dailyVisitors = new Map();
  const pageViews = new Map();
  for (const e of entries) {
    if (!isPageRequest(e.uri, e.method, e.status)) continue;
    const group = assetGroups.get(visitorKey(e));
    if (!group) continue;
    if (!hasTimestampWithin(group.css, e.timestamp, EVIDENCE_WINDOW_MS)) continue;
    if (!hasTimestampWithin(group.evidence, e.timestamp, EVIDENCE_WINDOW_MS)) continue;

    if (!dailyVisitors.has(e.date)) dailyVisitors.set(e.date, new Set());
    dailyVisitors.get(e.date).add(e.ip);
    pageViews.set(e.uri, (pageViews.get(e.uri) ?? 0) + 1);
  }
  return { dailyVisitors, pageViews };
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

  let filesProcessed = 0;
  const allEntries = [];
  const results = await Promise.allSettled(keys.map(k => collectEntries(k)));
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "fulfilled") {
      filesProcessed++;
      allEntries.push(...results[i].value);
    } else {
      console.error(`Error processing ${keys[i]}: ${results[i].reason}`);
    }
  }
  console.log(`Processed ${filesProcessed} log files`);

  // Only count a page view (by ip+UA) when both the CSS and the evidence
  // asset were also fetched within ±1 hour of it — a single hotlinked asset,
  // or an unrelated visit hours apart from the same ip+UA, isn't enough.
  const assetGroups = buildAssetTimestamps(allEntries);
  const { dailyVisitors, pageViews } = aggregateVisitorsAndPages(allEntries, assetGroups);

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
