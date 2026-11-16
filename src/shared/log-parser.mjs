import { gunzipSync } from "node:zlib";

// CloudFront standard logs are gzipped; fall back to plain text for uncompressed objects.
export function decodeLogBuffer(raw) {
  try {
    return gunzipSync(raw).toString("utf-8");
  } catch {
    return raw.toString("utf-8");
  }
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
