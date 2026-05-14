# Blog Analytics (SAM)

Generates daily visitor and top pages charts from CloudFront JSON logs.  
Outputs JSON files to your static site S3 bucket, rendered by Chart.js on your about page.

[![CodeQL](https://github.com/christ-off/blog-analytics/actions/workflows/github-code-scanning/codeql/badge.svg)](https://github.com/christ-off/blog-analytics/actions/workflows/github-code-scanning/codeql) [![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=christ-off_blog-analytics&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=christ-off_blog-analytics)

## Architecture

```
EventBridge (daily 06:00 UTC)
  └─ Lambda (Node.js 22)
       ├─ Reads last 30 days of CloudFront .gz logs from S3
       ├─ Filters bots, probes, assets
       ├─ Writes visitors.json + pages.json to website S3
       └─ Invalidates CloudFront cache
```

## Prerequisites

- AWS CLI configured (`aws configure`)
- SAM CLI installed (`pip install aws-sam-cli`)

## Deploy

```bash
sam build
sam deploy --guided
```

On first deploy, SAM will prompt for:

| Parameter        | Value                                      |
|------------------|--------------------------------------------|
| `LogsBucket`     | Your CloudFront logs bucket name           |
| `LogsPrefix`     | Key prefix for logs (empty if at root)     |
| `WebsiteBucket`  | Your website S3 bucket name                |
| `DistributionId` | Your CloudFront distribution ID            |

SAM saves your answers in `samconfig.toml` for subsequent deploys (`sam deploy` without `--guided`).

## Test locally

```bash
sam build
sam local invoke AnalyticsFunction
```

## Test in AWS (manual trigger)

```bash
aws lambda invoke \
  --region eu-west-3 \
  --cli-read-timeout 0 \
  --function-name $(sam list stack-outputs --stack-name daily-statistics --region eu-west-3 --output json | jq -r '.[] | select(.OutputKey=="FunctionName") | .OutputValue') \
  /dev/stdout
```

## Jekyll integration

Copy the contents of `chart-snippet.html` into your `about.md` (or `about.html`) page.

Chart.js is loaded from cdnjs — no cookies, no tracking, consistent with your privacy policy.

## Monthly cost

| Resource                          | Cost     |
|-----------------------------------|----------|
| Lambda (1 run/day, ~30s, 512MB)   | ~$0.00   |
| S3 reads (log files)              | ~$0.01   |
| CF invalidation (1/day)           | $0.00    |
| **Total**                         | **~$0**  |

## Bot filtering

The Lambda excludes:
- Known bots (Googlebot, GPTBot, SEMrush, Ahrefs, etc.)
- Empty / missing user agents
- HEAD requests
- PHP/WordPress probes (wp-login, xmlrpc, .env, etc.)
- Static assets (CSS, JS, images, fonts, XML, JSON)

Only `GET` requests returning `2xx`/`3xx` for HTML pages are counted.  
Unique visitors = unique IPs per day.
