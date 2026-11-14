# ASN blocking — consolidated plan

Condensed from the guidance document, the organization proposal and the status document (state as of Nov 12, 2026). Those three stay as the detailed record; this one is the working plan.

## 1. Goal and approach

Block scrapers from hosting/datacenter ASNs on the static blog (S3 + CloudFront), without hurting real readers or useful crawlers.

**Pipeline (decided):**

1. CloudFront standard logs (v2, w3c) now carry the `asn` column.
2. A daily job in `blog-analytics` (second SAM function) reads the logs and classifies observed ASNs with public lists.
3. It writes a **proposed list to S3 for human review** (not directly to the KVS at first).
4. Approved ASNs go into a CloudFront **KeyValueStore (KVS)**, which the existing CloudFront Function reads in addition to its static regex.
5. `analyze-logs` shows the effect (blocked ASNs, before/after).

**Rules that govern the design:**

- Block an ASN only if at least one source says *hosting* **and** none says *Cable/DSL/ISP*. Hosting-only must be verified by hand (`AGENTS.md` of the function project).
- The allowlist wins: `allowedHostedSoftwareRegex` (Googlebot AS15169, Bingbot AS8075, Applebot AS714, Qwantbot AS199064, Feedly AS60653).
- Fail open: if the KVS read fails, let the request through.
- Start with the public lists (C) for classification only. Behaviour scoring (D: non-human ratio, `lastSeen` expiry after ~30 days) comes later.

**Decisions made:**

| Topic | Decision |
|---|---|
| Where the job lives | `blog-analytics`, second function (no new repo) |
| Tooling | SAM / CloudFormation; the distribution itself is not imported |
| Blocking mechanism | KVS (option A) read by the existing function; WAF (B) stays a fallback |
| Detection | Public hosting lists first (C), behaviour scoring (D) later |
| Rollout | Proposed list for review first, then automatic |

**Why a KVS:** `function.js` is ~8 KB against a hard 10 KB limit and `blockedAsnRegex` already holds ~60 ASNs. KVS limits: 5 MB, key ≤ 512 B, value ≤ 1 KB; 2M reads/month free, then $0.03/M. The function needs the `CloudFront-Viewer-ASN` header via an origin request policy (not the cache policy, so no effect on cache hits).

## 2. Current state

**Done**

- `asn` added to the log delivery (35 fields, verified in new files from Nov 11, 22:00 UTC). The delivery is in the `cloudfront-logging` stack (`us-east-1`, `infra/cloudfront-logging.yaml`); change logging only through that template.
- Logs bucket and policy in the `logs-bucket` stack (`eu-west-3`), retention 90 days (`LogRetentionDays`, pass it explicitly on deploy).
- `blog-analytics` still works with the extra column (manual invoke OK).
- No pre-April log objects remain, so the old-format concern is moot.
- `analyze-logs`: ASN column (Liquibase `025-add-asn`), `/asn` page with top ASN chart, `asn_info` names table. `asn_info.category` is still empty.
- First classification pass on ~20 h of data (1,952 requests, 196 ASNs); scripts in `blog-analytics/scripts/asn-exploration/`.

**Not started:** restructuring `blog-analytics`, the ASN job, the KVS, the function change, the effect measurement.

**Note:** the workspace `CLAUDE.md` still says the logs have no ASN. That is now outdated for `analyze-logs`/live logs and should be updated.

**First-pass findings (too short to conclude, validates the method)**

- Sources: quantcdn (`metadata.category`) is the best signal; brianhama is a strict subset of it; X4BNet is IP ranges, so match on IP not ASN; PeeringDB is noisy, so use it as a veto against calling an ISP hosting, not as a positive signal.
- Block candidates: 138915 (Kaopu), 48090 (TECHOFF), 24940/16276/14061/212238 (Hetzner, OVH, DigitalOcean, Datacamp), 136907/55990/45090/132203 (Huawei, Tencent), 50300 (CustodianDC, check by hand).
- Never auto-block: allowlisted crawlers (714, 199064, 8075, 15169, 60653), Zscaler 62044, Cloudflare 13335, Hurricane Electric 6939, consumer ISPs, China Telecom/Unicom.
- 38 requests have no ASN (`-`); cause not investigated.

## 3. Implementation plan and validation

Each phase ends with a checkpoint; do not start the next until its validation passes.

### Phase A — Finish the offline classification (step 3)

- [ ] Wait for several full days of logs with `asn` (at least 5–7 days, covering a weekend).
- [ ] Re-run `scripts/asn-exploration/` on the full sample.
- [ ] Per candidate ASN, check hosting-only: user agents, client IPs, human-traffic share (the `analyze-logs` ASN detail page below helps).
- [ ] Investigate the requests with ASN `-` (IPv6 / unmapped?).
- [ ] Fill `asn_info.category` and add the ASN detail page in `analyze-logs`.

**Validation:**

- Every candidate satisfies the rule (a source says hosting, none says ISP) and has a written hosting-only note.
- No candidate appears in the allowlist or carries meaningful human traffic.
- A repeat-scanner is distinguishable from a one-time visit over the multi-day window.
- Output: a reviewed candidate list that becomes the reference test fixture for Phase C.

### Phase B — Restructure `blog-analytics` (step 4)

- [ ] Split `CodeUri` into `src/analytics/`, `src/asn-job/`, `src/shared/` (log parser, with tests).
- [ ] Two functions, separate IAM roles: analytics keeps the website-bucket and invalidation rights; the ASN job gets log read and (later) KVS write only.
- [ ] Keep the stack name `daily-statistics`.

**Validation:**

- `npm test` passes; parser tests unchanged in behaviour.
- `sam build` and `sam deploy --no-execute-changeset` show no resource replacement (no recreation of the existing function, bucket content or schedule).
- Manual invoke of the analytics function: same output (`visitors.json`, `pages.json`) as before the refactor (diff the files).
- IAM check: the ASN role cannot write to the website bucket.

### Phase C — ASN job in dry-run mode (step 5)

- [ ] Implement classification (quantcdn, brianhama, PeeringDB veto, X4BNet by IP) in `src/asn-job/`.
- [ ] Apply the block rule and the allowlist; also consume the static `blockedAsnRegex` so already-blocked ASNs are not proposed again.
- [ ] Write the proposed list to S3 (separate prefix, not the website bucket's public content), with per-ASN evidence (counts, sources, reasons).
- [ ] Schedule it daily via EventBridge; no KVS access yet.

**Validation:**

- Unit tests with the Phase A fixture: allowlisted ASNs never appear; an ISP-flagged ASN never appears; known candidates do.
- Run against real logs for several days; a human reviews each proposed list and flags false positives. Target: zero false positives in the reviewed window.
- Confirm the output is not publicly readable.

### Phase D — KVS and function (step 6)

- [ ] Verify whether Node KVS writes need `@aws-sdk/signature-v4-crt` (SigV4a). If yes, accept the end of "no production dependencies" or isolate it in the ASN function only.
- [ ] Create the KVS in the SAM template; expose its ARN.
- [ ] Add the origin request policy with `CloudFront-Viewer-ASN` on the behaviour (manual change to the existing distribution; record it in the docs).
- [ ] Decide the merge rules: allowlist wins over everything; manual regex and KVS list are both block layers; document the order in the function README (keep `// rationale: README.md#anchor` comments in sync).
- [ ] Decide the response code for KVS matches (the function returns 404 today; the guidance says 403).
- [ ] Update `function.js` within ES5.1 + the CloudFront allowlist (no `?.`, `??`, destructuring, `Map`/`Set`, …) and under 10 KB; fail open on KVS errors.
- [ ] Pass the KVS ARN to the project's GitHub Action and associate it with the function.
- [ ] Release 1, **log-only mode**: the function records the would-be block (e.g. a header or distinct log marker) without blocking. Release 2: enforce.

**Validation:**

- Vitest covers: allowlisted ASN passes, KVS hit blocks, KVS miss passes, KVS error fails open, manual regex still works.
- Size check on `function.js` (< 10 KB) and a CloudFront `test-function` run with sample events before publishing.
- KVS write test with 1–2 harmless keys, then read back via `cloudfront-keyvaluestore describe/get-key`.
- Log-only phase: for several days, compare would-be blocks with the reviewed list; no allowlisted crawler or known reader affected (check Googlebot/Bingbot verification by UA + reverse DNS).
- After enforcing: watch `analyze-logs` for blocked requests turning into Filtered/Error; roll back by removing the keys (or setting the function back to the previous version).

### Phase E — Measure and iterate (step 7)

- [ ] Before/after comparison for a blocked ASN (e.g. AS138915): its traffic becomes Filtered/Error in `analyze-logs`.
- [ ] Review weekly for the first month; add expiry (`lastSeen`, ~30 days) and consider behaviour scoring (D) once the list-based approach is stable.
- [ ] Switch from reviewed proposals to automatic writes only after a clean period and with a safety cap (e.g. max N new ASNs per day, alert above it).

**Validation:**

- Request volume from blocked ASNs drops to ~0 as hits; no rise in complaints or in blocked human traffic (human-traffic share per ASN).
- Search-engine crawls continue (Googlebot/Bingbot requests unchanged).

### Housekeeping

- [ ] Push the unpushed commits in `blog-analytics` and `analyze-logs`.
- [ ] Decide where the workspace-level documents live: their own repo in `blog-filtering/`, or only these files in the parent repo `/Users/christophe/Workspaces`. Then commit them (including this file).
- [ ] Update the workspace `CLAUDE.md` (logs now contain the ASN).
- [ ] Optionally record the origin request policy and distribution changes somewhere, since the distribution is outside IaC.

## 4. Open points and risks

| Item | Status |
|---|---|
| WAF ASN-match: max ASNs per rule, Free-plan eligibility | Unverified; only matters if falling back to option B |
| KVS write needs SigV4a dependency? | Unverified (Phase D) |
| Merge rules (manual regex / allowlist / KVS) | Allowlist wins; rest to define (Phase D) |
| Response code for KVS matches | 403 (guidance) vs 404 (current function) |
| Requests with no ASN | Not investigated (Phase A) |
| Sample size | One day cannot tell scanners from one-time visits (Phase A) |

**Risks to keep in mind**

- *False positives:* iCloud Private Relay (Akamai/Cloudflare ASNs) and corporate VPNs (Zscaler) are real readers. Consider a 403/404 page with a contact link rather than silent rejection.
- *Search ranking:* never block verified Googlebot/Bingbot ASNs.
- *Silent drift:* the distribution is not in IaC, so log fields and policies can change outside the templates; keep the drift checks (`IN_SYNC`) on the two stacks.
- *Cost:* expected ≈ $0 (KVS reads within the free tier, few KVS writes batched daily).

## 5. Reference

- Distribution `E1Z5N5X273TPT1`; SAM stack `daily-statistics` in `eu-west-3`; the CloudWatch Logs delivery API lives in `us-east-1` (delivery `8T56FbbIZZfqU6sj`).
- Logs bucket `post-tenebras-lire-access-logs`, prefix `AWSLogs/<account>/CloudFront/`, w3c format, 90-day retention.
- Classification sources: [X4BNet/lists_vpn](https://github.com/X4BNet/lists_vpn), [brianhama/bad-asn-list](https://github.com/brianhama/bad-asn-list), [PeeringDB](https://docs.peeringdb.com/blog/network_type_what_why_how/), [quantcdn/asn-info](https://gh.r-mj.com/quantcdn/asn-info).
- AWS: [CloudFront headers](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/adding-cloudfront-headers.html), [KeyValueStore](https://aws.amazon.com/blogs/aws/introducing-amazon-cloudfront-keyvaluestore-a-low-latency-datastore-for-cloudfront-functions), [WAF ASN match](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-asn-match.html), [flat-rate plans](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html).
