# ASN exploration (step 3, offline)

Throwaway analysis scripts, not part of the Lambda package (`CodeUri: src/`).
They aggregate CloudFront w3c logs that carry the `asn` column per ASN, then
cross-check the ASNs against public classification sources. Python 3, standard
library only. Results are input for the manual `blockedAsnRegex` in
`cloudfront-function-filter-traffic`; see the workspace status document.

Pick a work directory outside the repo (`$WORK` below) so the downloaded data
stays untracked and apart from the scripts.

## 1. Download logs and lists

```bash
WORK=/path/to/workdir; mkdir -p $WORK/logs $WORK/lists
B=post-tenebras-lire-access-logs; P=AWSLogs/424590257573/CloudFront/

# logs from the day the asn field was added (Nov 11, 2026 22:00 UTC) onward
aws s3 sync s3://$B/$P $WORK/logs --exclude '*' --include 'E1Z5N5X273TPT1.2026-11-*' --only-show-errors

# keep only the files whose #Fields header ends with asn (macOS zcat wants .Z, use gzip -dc)
cd $WORK/logs && for f in *.gz; do
  gzip -dc $f | grep -m1 '^#Fields' | grep -q 'asn$' && echo $f
done > $WORK/with_asn.txt

cd $WORK/lists
curl -sSLO https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter/ipv4.txt
curl -sSLO https://raw.githubusercontent.com/brianhama/bad-asn-list/master/bad-asn-list.csv
curl -sSLO https://raw.githubusercontent.com/quantcdn/asn-info/master/as.json   # ~67 MB, category is metadata.category
```

## 2. Aggregate, then fetch PeeringDB for the observed ASNs

```bash
python3 -I aggregate.py $WORK/logs $WORK/with_asn.txt $WORK/agg.json

ASNS=$(python3 -I -c "import json,sys; print(','.join(sorted((a for a in json.load(open(sys.argv[1]))['asns'] if a.isdigit()), key=int)))" $WORK/agg.json)
curl -sS "https://www.peeringdb.com/api/net?asn__in=$ASNS&fields=asn,name,info_type,info_types" -o $WORK/lists/peeringdb.json
```

## 3. Cross-check

```bash
python3 -I classify.py $WORK    # prints the top 40 ASNs, writes $WORK/classified.json
```

Columns: requests, distinct IPs, bot-like user agents, requests already
stopped by the function (`FunctionGeneratedResponse`), 404s, then the four
sources (brianhama, X4BNet matched on client IP, PeeringDB type, quantcdn
category).

## Reading the result

Rule: block only if a source says hosting and none says ISP, and check the
provider is hosting-only (registry lookup). Hosting ASNs that carry legitimate
crawlers or proxies (Apple, Google, Microsoft, Zscaler, Cloudflare, Feedly)
need the allowlist or a human decision, not an automatic block.
