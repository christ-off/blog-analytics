# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

AWS SAM application — a Python Lambda that runs daily, reads 30 days of CloudFront `.gz` logs from S3, and writes `visitors.json` + `pages.json` to a static website S3 bucket. EventBridge triggers it at 06:00 UTC.

## Commands

```bash
# Tests
npm test

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

- `src/handler.mjs` — single Lambda entry point (`handler(event, context)`); pure functions (`isBot`, `isPageRequest`, `parseTsvLines`) are exported for testing
- `tests/handler.test.mjs` — Vitest unit tests
- `package.json` — dev dependencies only (Vitest + AWS SDK for local testing); not included in Lambda package (`CodeUri: src/`)
- `template.yaml` — SAM template; defines the function, IAM policies, schedule, and parameters
- `chart-snippet.html` — client-side Chart.js snippet to embed in the Jekyll `about.md` page

## Runtime

- Node.js 22, 512 MB, 600s timeout
- AWS SDK v3 provided by Lambda runtime (no production dependencies)

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

<!-- rtk-instructions v2 -->
# RTK (Rust Token Killer) - Token-Optimized Commands

## Golden Rule

**Always prefix commands with `rtk`**. If RTK has a dedicated filter, it uses it. If not, it passes through unchanged. This means RTK is always safe to use.

**Important**: Even in command chains with `&&`, use `rtk`:
```bash
# ❌ Wrong
git add . && git commit -m "msg" && git push

# ✅ Correct
rtk git add . && rtk git commit -m "msg" && rtk git push
```

## RTK Commands by Workflow

### Build & Compile (80-90% savings)
```bash
rtk cargo build         # Cargo build output
rtk cargo check         # Cargo check output
rtk cargo clippy        # Clippy warnings grouped by file (80%)
rtk tsc                 # TypeScript errors grouped by file/code (83%)
rtk lint                # ESLint/Biome violations grouped (84%)
rtk prettier --check    # Files needing format only (70%)
rtk next build          # Next.js build with route metrics (87%)
```

### Test (60-99% savings)
```bash
rtk cargo test          # Cargo test failures only (90%)
rtk go test             # Go test failures only (90%)
rtk jest                # Jest failures only (99.5%)
rtk vitest              # Vitest failures only (99.5%)
rtk playwright test     # Playwright failures only (94%)
rtk pytest              # Python test failures only (90%)
rtk rake test           # Ruby test failures only (90%)
rtk rspec               # RSpec test failures only (60%)
rtk test <cmd>          # Generic test wrapper - failures only
```

### Git (59-80% savings)
```bash
rtk git status          # Compact status
rtk git log             # Compact log (works with all git flags)
rtk git diff            # Compact diff (80%)
rtk git show            # Compact show (80%)
rtk git add             # Ultra-compact confirmations (59%)
rtk git commit          # Ultra-compact confirmations (59%)
rtk git push            # Ultra-compact confirmations
rtk git pull            # Ultra-compact confirmations
rtk git branch          # Compact branch list
rtk git fetch           # Compact fetch
rtk git stash           # Compact stash
rtk git worktree        # Compact worktree
```

Note: Git passthrough works for ALL subcommands, even those not explicitly listed.

### GitHub (26-87% savings)
```bash
rtk gh pr view <num>    # Compact PR view (87%)
rtk gh pr checks        # Compact PR checks (79%)
rtk gh run list         # Compact workflow runs (82%)
rtk gh issue list       # Compact issue list (80%)
rtk gh api              # Compact API responses (26%)
```

### JavaScript/TypeScript Tooling (70-90% savings)
```bash
rtk pnpm list           # Compact dependency tree (70%)
rtk pnpm outdated       # Compact outdated packages (80%)
rtk pnpm install        # Compact install output (90%)
rtk npm run <script>    # Compact npm script output
rtk npx <cmd>           # Compact npx command output
rtk prisma              # Prisma without ASCII art (88%)
```

### Files & Search (60-75% savings)
```bash
rtk ls <path>           # Tree format, compact (65%)
rtk read <file>         # Code reading with filtering (60%)
rtk grep <pattern>      # Search grouped by file (75%)
rtk find <pattern>      # Find grouped by directory (70%)
```

### Analysis & Debug (70-90% savings)
```bash
rtk err <cmd>           # Filter errors only from any command
rtk log <file>          # Deduplicated logs with counts
rtk json <file>         # JSON structure without values
rtk deps                # Dependency overview
rtk env                 # Environment variables compact
rtk summary <cmd>       # Smart summary of command output
rtk diff                # Ultra-compact diffs
```

### Infrastructure (85% savings)
```bash
rtk docker ps           # Compact container list
rtk docker images       # Compact image list
rtk docker logs <c>     # Deduplicated logs
rtk kubectl get         # Compact resource list
rtk kubectl logs        # Deduplicated pod logs
```

### Network (65-70% savings)
```bash
rtk curl <url>          # Compact HTTP responses (70%)
rtk wget <url>          # Compact download output (65%)
```

### Meta Commands
```bash
rtk gain                # View token savings statistics
rtk gain --history      # View command history with savings
rtk discover            # Analyze Claude Code sessions for missed RTK usage
rtk proxy <cmd>         # Run command without filtering (for debugging)
rtk init                # Add RTK instructions to CLAUDE.md
rtk init --global       # Add RTK to ~/.claude/CLAUDE.md
```

## Token Savings Overview

| Category | Commands | Typical Savings |
|----------|----------|-----------------|
| Tests | vitest, playwright, cargo test | 90-99% |
| Build | next, tsc, lint, prettier | 70-87% |
| Git | status, log, diff, add, commit | 59-80% |
| GitHub | gh pr, gh run, gh issue | 26-87% |
| Package Managers | pnpm, npm, npx | 70-90% |
| Files | ls, read, grep, find | 60-75% |
| Infrastructure | docker, kubectl | 85% |
| Network | curl, wget | 65-70% |

Overall average: **60-90% token reduction** on common development operations.
<!-- /rtk-instructions -->