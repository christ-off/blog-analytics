"""Aggregate the w3c logs that carry an asn column, per ASN.

usage: python3 -I aggregate.py <logs_dir> <files_list> <out_json>
"""
import gzip, json, re, sys
from collections import defaultdict

logs_dir, files_list, out = sys.argv[1:4]
BOT_UA = re.compile(r"bot|crawl|spider|scrap|slurp|curl|wget|python|go-http|java/|okhttp|httpclient|libwww|axios|node-fetch|headless|^-$", re.I)

agg = defaultdict(lambda: {"req": 0, "ips": set(), "bot_ua": 0, "blocked": 0,
                           "s404": 0, "s2xx": 0, "pages": 0, "uas": defaultdict(int)})
total = 0
for name in open(files_list).read().split():
    fields = None
    for line in gzip.open(f"{logs_dir}/{name}", "rt", errors="replace"):
        if line.startswith("#Fields:"):
            fields = line.rstrip("\n").split(": ", 1)[1].split("\t")
            continue
        if line.startswith("#") or fields is None:
            continue
        r = dict(zip(fields, line.rstrip("\n").split("\t")))
        asn = r.get("asn", "-")
        a = agg[asn]
        total += 1
        a["req"] += 1
        a["ips"].add(r["c-ip"])
        ua = r["cs(User-Agent)"]
        if BOT_UA.search(ua):
            a["bot_ua"] += 1
        a["uas"][ua] += 1
        if r["x-edge-result-type"] == "FunctionGeneratedResponse":
            a["blocked"] += 1
        st = r["sc-status"]
        if st == "404":
            a["s404"] += 1
        elif st.startswith("2"):
            a["s2xx"] += 1
            if r["cs-method"] == "GET" and not re.search(r"\.[a-z0-9]{2,5}$", r["cs-uri-stem"]):
                a["pages"] += 1

res = {}
for asn, a in agg.items():
    top = sorted(a["uas"].items(), key=lambda kv: -kv[1])[:3]
    res[asn] = {"req": a["req"], "ips": len(a["ips"]), "ip_list": sorted(a["ips"])[:2000],
                "bot_ua": a["bot_ua"], "blocked": a["blocked"], "s404": a["s404"],
                "s2xx": a["s2xx"], "pages": a["pages"], "top_ua": top}
json.dump({"total": total, "asns": res}, open(out, "w"))
print(total, "requests,", len(res), "ASNs")
