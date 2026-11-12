"""Cross-check observed ASNs against the four public sources.

usage: python3 -I classify.py <scratchpad>
"""
import bisect, csv, ipaddress, json, os, sys

sp = sys.argv[1]
data = json.load(open(f"{sp}/agg.json"))
asns = data["asns"]

# brianhama/bad-asn-list: hosting / cloud / colo ASNs
brian = {}
for row in csv.DictReader(open(f"{sp}/lists/bad-asn-list.csv")):
    brian[row["ASN"].strip()] = row["Entity"].strip().strip('"')

# X4BNet datacenter ranges, matched on client IP (IPv4 only in this file)
nets = sorted((int(n.network_address), int(n.broadcast_address))
              for n in (ipaddress.ip_network(l.strip()) for l in open(f"{sp}/lists/ipv4.txt") if l.strip()))
starts = [s for s, _ in nets]

def in_dc(ip):
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if a.version != 4:
        return False
    i = bisect.bisect_right(starts, int(a)) - 1
    return i >= 0 and int(a) <= nets[i][1]

pdb = {str(e["asn"]): e for e in json.load(open(f"{sp}/lists/peeringdb.json"))["data"]}

quant = {}
qp = f"{sp}/lists/as.json"
if os.path.exists(qp):
    try:
        for e in json.load(open(qp)):
            quant[str(e["asn"])] = e
    except Exception as ex:  # truncated download
        print("as.json unreadable:", ex, file=sys.stderr)

rows = []
for asn, a in asns.items():
    ips = a["ip_list"]
    dc_ips = sum(in_dc(i) for i in ips)
    q = quant.get(asn, {})
    rows.append({
        "asn": asn, "req": a["req"], "ips": a["ips"], "bot_ua": a["bot_ua"],
        "blocked": a["blocked"], "s404": a["s404"], "pages": a["pages"],
        "name": (q.get("metadata") or {}).get("description") or pdb.get(asn, {}).get("name") or brian.get(asn, ""),
        "brian": asn in brian,
        "x4b": f"{dc_ips}/{len(ips)}",
        "x4b_any": dc_ips > 0,
        "pdb": pdb.get(asn, {}).get("info_type", ""),
        "quant": (q.get("metadata") or {}).get("category", ""),
        "top_ua": a["top_ua"][0][0][:60] if a["top_ua"] else "",
    })
rows.sort(key=lambda r: -r["req"])
json.dump(rows, open(f"{sp}/classified.json", "w"), indent=1)
print(f"{'asn':>7} {'req':>5} {'ips':>4} {'bot':>4} {'blk':>4} {'404':>4} {'brn':>3} {'x4b':>7} {'pdb':<10} {'quant':<12} name")
for r in rows[:40]:
    print(f"{r['asn']:>7} {r['req']:>5} {r['ips']:>4} {r['bot_ua']:>4} {r['blocked']:>4} {r['s404']:>4} "
          f"{'Y' if r['brian'] else '-':>3} {r['x4b']:>7} {r['pdb']:<10} {r['quant']:<12} {r['name'][:40]}")
