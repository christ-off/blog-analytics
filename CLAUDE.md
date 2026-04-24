# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

AWS SAM application — a Python Lambda that runs daily, reads 30 days of CloudFront `.gz` logs from S3, and writes `visitors.json` + `pages.json` to a static website S3 bucket. EventBridge triggers it at 06:00 UTC.

## Commands

```bash
# Build
sam build

# Deploy (first time — prompts for LogsBucket, LogsPrefix, WebsiteBucket, DistributionId)
sam deploy --guided

# Deploy (subsequent)
sam deploy

# Run locally (requires AWS credentials)
sam local invoke AnalyticsFunction

# Trigger deployed function manually
aws lambda invoke \
  --region eu-west-3 \
  --cli-read-timeout 0 \
  --function-name $(sam list stack-outputs --stack-name daily-statistics --region eu-west-3 --output json | jq -r '.[] | select(.OutputKey=="FunctionName") | .OutputValue') \
  /tmp/lambda-out.json && cat /tmp/lambda-out.json
```

## Architecture

- `src/handler.py` — single Lambda entry point (`handler(event, context)`)
- `template.yaml` — SAM template; defines the function, IAM policies, schedule, and parameters
- `chart-snippet.html` — client-side Chart.js snippet to embed in the Jekyll `about.md` page

### Data flow

1. Lambda lists all objects under `LOGS_PREFIX` in `LOGS_BUCKET`, filters by date extracted from filename (`_YYYY-MM-DD-HH_` pattern)
2. Each `.gz` log file is decompressed and parsed as TSV (CloudFront standard log format); the `#Fields:` header line drives column mapping
3. Bots, probes, assets, and non-GET/non-2xx/3xx requests are filtered out
4. Aggregates unique IPs per day (`daily_visitors`) and page view counts (`page_views`)
5. Writes `about/data/visitors.json` and `about/data/pages.json` to `WEBSITE_BUCKET`
6. Invalidates those two CloudFront paths

### Output JSON shape

```json
{ "generated": "...", "labels": ["2026-03-22", ...], "values": [42, ...] }
```

## Runtime

- Python 3.12, 512 MB, 300s timeout
- No `requirements.txt` — only stdlib + `boto3` (provided by Lambda runtime)
