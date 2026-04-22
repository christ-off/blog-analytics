"""
Blog analytics Lambda: processes CloudFront JSON logs (gzipped),
filters bots/probes/assets, outputs daily visitors + top pages JSON.
"""

import boto3
import gzip
import json
import os
import re
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from urllib.parse import unquote

s3 = boto3.client("s3")
cf = boto3.client("cloudfront")

LOGS_BUCKET = os.environ["LOGS_BUCKET"]
LOGS_PREFIX = os.environ.get("LOGS_PREFIX", "")
WEBSITE_BUCKET = os.environ["WEBSITE_BUCKET"]
DISTRIBUTION_ID = os.environ["DISTRIBUTION_ID"]
OUTPUT_PREFIX = "about/data"
DAYS = 30
TOP_PAGES = 15

# --- Filters ---

BOT_RE = re.compile(
    r"bot|crawl|spider|feedly|feeder|slurp|semrush|ahrefs|"
    r"python|curl|wget|Go-http|HeadlessChrome|Googlebot|"
    r"bingbot|YandexBot|Bytespider|DotBot|MJ12bot|"
    r"PetalBot|GPTBot|ClaudeBot|CCBot|"
    r"facebookexternalhit|Twitterbot|LinkedInBot|"
    r"DataForSeoBot|Applebot|archive\.org|"
    r"Sogou|Baiduspider|ia_archiver|"
    r"Uptimebot|monitoring|pingdom|StatusCake",
    re.IGNORECASE,
)

PATH_EXCLUDE_RE = re.compile(
    r"\.(php|asp|aspx|cgi)$|wp-|xmlrpc|wp-login|"
    r"\.env|\.git|/admin|/login|phpmyadmin",
    re.IGNORECASE,
)

ASSET_RE = re.compile(
    r"\.(css|js|png|jpg|jpeg|gif|svg|ico|webp|webm|avif|"
    r"woff|woff2|ttf|eot|map|xml|json|txt|gz)$",
    re.IGNORECASE,
)

DATE_IN_KEY_RE = re.compile(r"\.(\d{4}-\d{2}-\d{2})-\d{2}\.")


def is_bot(user_agent: str) -> bool:
    if not user_agent or user_agent == "-":
        return True
    return bool(BOT_RE.search(unquote(user_agent)))


def is_page_request(uri: str, method: str, status: str) -> bool:
    if method != "GET":
        return False
    if not status.startswith("2") and not status.startswith("3"):
        return False
    if PATH_EXCLUDE_RE.search(uri):
        return False
    if ASSET_RE.search(uri):
        return False
    return True


# --- Main ---


def handler(event, context):
    today = datetime.utcnow().date()
    start_date = today - timedelta(days=DAYS)

    daily_visitors = defaultdict(set)  # date_str -> {ip, ...}
    page_views = defaultdict(int)  # uri -> count

    # List all log files, filter by date in filename
    paginator = s3.get_paginator("list_objects_v2")
    keys = []

    for page in paginator.paginate(Bucket=LOGS_BUCKET, Prefix=LOGS_PREFIX):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            match = DATE_IN_KEY_RE.search(key)
            if not match:
                continue
            file_date = datetime.strptime(match.group(1), "%Y-%m-%d").date()
            if file_date < start_date or file_date > today:
                continue
            keys.append(key)

    def fetch(key):
        result = defaultdict(set), defaultdict(int)
        process_log_file(key, result[0], result[1])
        return result

    files_processed = 0
    with ThreadPoolExecutor(max_workers=32) as executor:
        futures = {executor.submit(fetch, k): k for k in keys}
        for future in as_completed(futures):
            try:
                visitors, pages = future.result()
                for date, ips in visitors.items():
                    daily_visitors[date].update(ips)
                for uri, count in pages.items():
                    page_views[uri] += count
                files_processed += 1
            except Exception as e:
                print(f"Error processing {futures[future]}: {e}")

    print(f"Processed {files_processed} log files")

    # Build visitors JSON (sorted by date, all 30 days)
    all_dates = []
    d = start_date
    while d <= today:
        ds = d.strftime("%Y-%m-%d")
        all_dates.append(ds)
        d += timedelta(days=1)

    visitors_json = {
        "generated": datetime.utcnow().isoformat() + "Z",
        "labels": all_dates,
        "values": [len(daily_visitors.get(d, set())) for d in all_dates],
    }

    # Build top pages JSON
    top = sorted(page_views.items(), key=lambda x: x[1], reverse=True)[:TOP_PAGES]
    pages_json = {
        "generated": datetime.utcnow().isoformat() + "Z",
        "labels": [p[0] for p in top],
        "values": [p[1] for p in top],
    }

    # Write to website bucket
    for filename, data in [("visitors.json", visitors_json), ("pages.json", pages_json)]:
        s3.put_object(
            Bucket=WEBSITE_BUCKET,
            Key=f"{OUTPUT_PREFIX}/{filename}",
            Body=json.dumps(data, ensure_ascii=False),
            ContentType="application/json",
            CacheControl="max-age=3600",
            ACL="public-read",
        )

    # Invalidate CloudFront cache
    cf.create_invalidation(
        DistributionId=DISTRIBUTION_ID,
        InvalidationBatch={
            "Paths": {
                "Quantity": 2,
                "Items": [
                    f"/{OUTPUT_PREFIX}/visitors.json",
                    f"/{OUTPUT_PREFIX}/pages.json",
                ],
            },
            "CallerReference": f"analytics-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}",
        },
    )

    summary = {
        "files_processed": files_processed,
        "days_with_data": len([d for d in all_dates if daily_visitors.get(d)]),
        "total_unique_visitors": sum(len(v) for v in daily_visitors.values()),
        "total_pages_tracked": len(page_views),
        "top_page": top[0] if top else None,
    }
    print(json.dumps(summary))
    return {"statusCode": 200, "body": json.dumps(summary)}


def process_log_file(key: str, daily_visitors: dict, page_views: dict):
    response = s3.get_object(Bucket=LOGS_BUCKET, Key=key)
    raw = response["Body"].read()

    # Handle both gzipped and plain files
    try:
        content = gzip.decompress(raw).decode("utf-8")
    except gzip.BadGzipFile:
        content = raw.decode("utf-8")

    for line in content.strip().split("\n"):
        if not line:
            continue

        entry = json.loads(line)
        user_agent = entry.get("cs(User-Agent)", "")
        uri = entry.get("cs-uri-stem", "")
        method = entry.get("cs-method", "")
        status = entry.get("sc-status", "")
        ip = entry.get("c-ip", "")
        log_date = entry.get("date", "")

        if is_bot(user_agent):
            continue
        if not is_page_request(uri, method, status):
            continue
        if not ip or ip == "-":
            continue

        daily_visitors[log_date].add(ip)
        page_views[uri] += 1
