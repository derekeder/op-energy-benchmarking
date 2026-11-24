"""Compare the benchmarking list with Cook County Assessor building sizes.

Benchmarking covers buildings of 10,000 ft² or more. This pulls building square
footage from three Cook County Assessor datasets, attaches it to parcels, and
compares it with the buildings in the benchmarking exports.

Assessor datasets (Oak Park only; PIN, address, size and use fields only):
  csik-bsws  Commercial Valuation Data: apartments (7+ units), commercial, mixed use.
             One record can cover several PINs. Uses bldgsf, else gross_building_area.
  3r7i-mrz4  Condominium Unit Characteristics: char_building_sf for the whole building
             (pin10), repeated on every unit.
  x54s-btds  Residential Improvement Characteristics: char_bldg_sf, summed across
             cards (buildings) on a PIN.
Tax-exempt property (schools, Village facilities, churches) isn't assessed, so it
has no size here.

Benchmarking buildings are tied to parcels through data/parcels.geojson (built by
match_parcels.py), using every address a Feature ID has had across years.

Output: reports/assessor_review.csv, one row per finding:
  not_on_list            Assessor building >= 10,000 ft² with no benchmarking building
                         on its parcels or next to them. Possibly a covered building
                         the Village isn't tracking.
  not_on_list_adjacent   Same, but a listed building's parcel is within ADJACENT_M.
                         Often the same building spread over several parcels (or a
                         parcel-matching gap) rather than a missing building.
  For both, likely_match names a listed building within 150 m whose self-reported
  floor area is within 10% of the Assessor's. That usually means the listed
  building was matched to the wrong parcel (fix in data/address_corrections.csv).
  assessor_under_10k     Covered on the site, but the Assessor size is under 10,000 ft².
  excluded_assessor_10k  Dropped by the site's floor-area rule, but the Assessor size
                         is 10,000 ft² or more.
  excluded_assessor_small Dropped by the site's floor-area rule; Assessor agrees or
                         has no size. Listed for completeness.
  no_assessor_size       Covered on the site, but no Assessor size (usually tax-exempt).

Downloads are cached in data/assessor/ (delete to refresh).

Usage: python3 scripts/assessor_review.py
"""
import csv
import glob
import json
import math
import os
import re
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
CACHE = os.path.join(DATA, "assessor")
OUT = os.path.join(ROOT, "reports", "assessor_review.csv")
API = "https://datacatalog.cookcountyil.gov/resource"
MIN_SF = 10000
ADJACENT_M = 30  # parcel-centroid distance treated as "next to" a listed building
OAK_PARK_TOWNSHIP_CODE = "27"

ID, GFA, GHG = "Oak Park Feature ID", "Property GFA - Self-Reported (ft²)", "Total GHG Emissions (Metric Tons CO2e)"
NAME, ADDR, ADDR1 = "Property Name", "CPL Property Address", "Address Line 1"

DATASETS = {
    "commercial": {
        "id": "csik-bsws",
        "select": "keypin,pins,year,address,class_es,bldgsf,gross_building_area,"
                  "property_type_use,tot_units,stories,yearbuilt",
        "where": "upper(township)='OAK PARK'",
        "year_field": "year",
    },
    "condo": {
        "id": "3r7i-mrz4",
        "select": "pin10,year,char_building_sf,char_building_pins",
        "where": f"township_code='{OAK_PARK_TOWNSHIP_CODE}'",
        "year_field": "year",
    },
    "residential": {
        "id": "x54s-btds",
        "select": "pin,year,card,class,char_bldg_sf",
        "where": f"township_code='{OAK_PARK_TOWNSHIP_CODE}'",
        "year_field": "year",
    },
}


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def pin10(p):
    return re.sub(r"\D", "", p or "")[:10]


def fetch(name):
    """Latest year of a dataset for Oak Park, cached as CSV."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{name}.csv")
    if os.path.exists(path):
        with open(path, encoding="utf-8", newline="") as f:
            return list(csv.DictReader(f))
    d = DATASETS[name]

    def get(params, fmt="json"):
        url = f"{API}/{d['id']}.{fmt}?{urllib.parse.urlencode(params)}"
        with urllib.request.urlopen(url, timeout=600) as resp:
            body = resp.read().decode("utf-8")
        return json.loads(body) if fmt == "json" else body

    years = get({"$select": f"max({d['year_field']}) as y", "$where": d["where"]})
    latest = str(int(float(years[0]["y"])))
    body = get({"$select": d["select"],
                "$where": f"{d['where']} AND {d['year_field']}='{latest}'",
                "$limit": "200000"}, fmt="csv")
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(body)
    rows = list(csv.DictReader(body.splitlines()))
    print(f"downloaded {name} ({latest}): {len(rows)} rows -> {path}")
    return rows


def assessor_records():
    """Return {record_id: {sf, source, description, address, pins:set}} and pin10 -> {record_id}."""
    records = {}
    for r in fetch("commercial"):
        sf = num(r["bldgsf"]) or num(r["gross_building_area"])
        pins = {pin10(p) for p in (r["pins"] or r["keypin"]).split(",") if pin10(p)}
        desc = r["property_type_use"] or ""
        if num(r["tot_units"]):
            desc += f" ({int(num(r['tot_units']))} units)"
        records[f"commercial:{r['keypin']}"] = {
            "sf": sf, "source": "commercial", "description": desc.strip(),
            "address": " ".join((r["address"] or "").split()), "pins": pins,
        }
    for r in fetch("condo"):
        key = f"condo:{r['pin10']}"
        sf = num(r["char_building_sf"])
        rec = records.setdefault(key, {"sf": sf, "source": "condo", "address": "",
                                       "description": "", "pins": {r["pin10"]}})
        rec["sf"] = max(rec["sf"] or 0, sf or 0) or None
        if num(r["char_building_pins"]):
            rec["description"] = f"condominium ({int(num(r['char_building_pins']))} PINs)"
    residential = {}
    for r in fetch("residential"):
        sf = num(r["char_bldg_sf"])
        if sf:
            residential.setdefault(pin10(r["pin"]), {})[(r["pin"], r["card"])] = (sf, r["class"])
    for p, cards in residential.items():
        key = f"residential:{p}"
        if key in records:
            continue
        classes = sorted({c for _, c in cards.values()})
        records[key] = {"sf": sum(sf for sf, _ in cards.values()), "source": "residential",
                        "description": "residential class " + "/".join(classes),
                        "address": "", "pins": {p}}

    by_pin = {}
    for rid, rec in records.items():
        for p in rec["pins"]:
            by_pin.setdefault(p, set()).add(rid)
    return records, by_pin


def parcel_addresses():
    """pin10 -> a street address (unit numbers dropped), from data/parcel_addresses.csv."""
    out = {}
    path = os.path.join(DATA, "parcel_addresses.csv")
    if os.path.exists(path):
        with open(path, encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                m = re.match(r"^(\d+\S*\s+(?:[NSEW]\s+)?\S+(?:\s+(?:AVE|ST|BLVD|RD|CT|PL|LN|DR|TER|PKWY))?)", r["address"])
                out.setdefault(r["pin10"], set()).add(m.group(1) if m else r["address"])
    return {p: " / ".join(sorted(a)[:3]) for p, a in out.items()}


def always_covered_ids():
    """Feature IDs listed in ALWAYS_COVERED in assets/js/data.js."""
    with open(os.path.join(ROOT, "assets", "js", "data.js"), encoding="utf-8") as f:
        js = f.read()
    block = js[js.index("ALWAYS_COVERED = {"):]
    block = block[:block.index("};")]
    return set(re.findall(r'"(\d+)"\s*:', block))


def benchmarking_buildings():
    """Feature ID -> {names, addresses, max_gfa, years_listed, years_reported}."""
    buildings = {}
    for path in sorted(glob.glob(os.path.join(DATA, "op-benchmarking-*.csv"))):
        year = re.search(r"(\d{4})", os.path.basename(path)).group(1)
        with open(path, encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                fid = r[ID].strip()
                if not fid:
                    continue
                b = buildings.setdefault(fid, {"names": [], "addresses": [], "max_gfa": None,
                                               "years_listed": [], "years_reported": []})
                b["years_listed"].append(year)
                if num(r[GHG]) is not None:
                    b["years_reported"].append(year)
                for k, col in (("names", NAME), ("addresses", ADDR)):
                    v = r[col].strip()
                    if v and v not in b[k]:
                        b[k].append(v)
                if not r[ADDR].strip() and r[ADDR1].strip() and r[ADDR1].strip() not in b["addresses"]:
                    b.setdefault("alt_addresses", []).append(r[ADDR1].strip())
                g = num(r[GFA])
                if g is not None:
                    b["max_gfa"] = max(b["max_gfa"] or 0, g)
    return buildings


def main():
    records, by_pin = assessor_records()
    addresses = parcel_addresses()
    for rec in records.values():
        if not rec["address"]:
            rec["address"] = " / ".join(addresses[p] for p in sorted(rec["pins"]) if p in addresses)
    always = always_covered_ids()
    buildings = benchmarking_buildings()

    with open(os.path.join(DATA, "parcels.geojson"), encoding="utf-8") as f:
        parcel_features = json.load(f)["features"]
    pins_by_address = {ft["properties"]["address"]: set(ft["properties"]["pins"]) for ft in parcel_features}

    # Parcel centroids, for locating unlisted buildings relative to listed ones.
    raw = sorted(glob.glob(os.path.join(DATA, "ccgisdata_-_Parcel_*.geojson")))[-1]
    with open(raw, encoding="utf-8") as f:
        centroid = {}
        for ft in json.load(f)["features"]:
            pts = [p for poly in ft["geometry"]["coordinates"] for p in poly[0]]
            centroid[ft["properties"]["pin10"]] = (sum(p[0] for p in pts) / len(pts),
                                                   sum(p[1] for p in pts) / len(pts))

    def meters(a, b):
        return math.hypot((a[0] - b[0]) * 83000, (a[1] - b[1]) * 111000)

    rows = []
    listed_pins = {}  # pin10 -> feature id
    for fid, b in buildings.items():
        pins = set()
        for a in b["addresses"]:
            pins |= pins_by_address.get(a, set())
        b["pins"] = pins
        for p in pins:
            listed_pins.setdefault(p, fid)
        rec_ids = set().union(*(by_pin.get(p, set()) for p in pins)) if pins else set()
        sizes = [records[r]["sf"] for r in rec_ids if records[r]["sf"]]
        b["assessor_sf"] = sum(sizes) if sizes else None
        b["assessor_desc"] = "; ".join(sorted({f"{records[r]['source']}: {records[r]['description']}".strip(": ")
                                                for r in rec_ids}))
        under = b["max_gfa"] is not None and b["max_gfa"] < MIN_SF
        b["covered"] = (not under) or fid in always

        if not b["covered"]:
            issue = "excluded_assessor_10k" if (b["assessor_sf"] or 0) >= MIN_SF else "excluded_assessor_small"
        elif not pins:
            issue = "no_assessor_size"
        elif b["assessor_sf"] is None:
            issue = "no_assessor_size"
        elif b["assessor_sf"] < MIN_SF:
            issue = "assessor_under_10k"
        else:
            continue
        rows.append({
            "issue": issue,
            "feature_id": fid,
            "name": " / ".join(b["names"]),
            "address": " / ".join(b["addresses"] or b.get("alt_addresses", [])),
            "pins": " ".join(sorted(pins)),
            "assessor_sf": int(b["assessor_sf"]) if b["assessor_sf"] else "",
            "assessor_description": b["assessor_desc"],
            "self_reported_sf_max": int(b["max_gfa"]) if b["max_gfa"] is not None else "",
            "covered_on_site": "yes" if b["covered"] else "no",
            "always_covered": "yes" if fid in always else "",
            "years_listed": " ".join(b["years_listed"]),
            "years_reported": " ".join(b["years_reported"]),
            "nearest_listed": "",
            "likely_match": "",
        })

    # Assessor buildings >= 10k with no benchmarking building on any of their parcels.
    for rid, rec in records.items():
        if (rec["sf"] or 0) < MIN_SF or rec["pins"] & set(listed_pins):
            continue
        near, dist = "", None
        c = next((centroid[p] for p in sorted(rec["pins"]) if p in centroid), None)
        if c:
            best = min(((meters(c, centroid[p]), fid) for p, fid in listed_pins.items() if p in centroid),
                       default=None)
            if best and best[0] <= 150:
                b = buildings[best[1]]
                dist = best[0]
                near = f"{best[1]} {(b['names'] or b['addresses'] or [''])[0]} ({round(best[0])} m)"
        likely = ""
        if c:
            cands = []
            for p, fid in listed_pins.items():
                g = buildings[fid]["max_gfa"]
                if p in centroid and g and abs(g - rec["sf"]) <= 0.1 * rec["sf"]:
                    d = meters(c, centroid[p])
                    if d <= 150:
                        cands.append((abs(g - rec["sf"]) / rec["sf"], d, fid))
            if cands:
                _, d, fid = min(cands)
                b = buildings[fid]
                likely = (f"{fid} {(b['names'] or b['addresses'] or [''])[0]} "
                          f"(self-reported {int(b['max_gfa']):,} ft², {round(d)} m)")
        rows.append({
            "issue": "not_on_list_adjacent" if dist is not None and dist <= ADJACENT_M else "not_on_list",
            "feature_id": "",
            "name": "",
            "address": rec["address"],
            "pins": " ".join(sorted(rec["pins"])),
            "assessor_sf": int(rec["sf"]),
            "assessor_description": f"{rec['source']}: {rec['description']}".strip(": "),
            "self_reported_sf_max": "",
            "covered_on_site": "",
            "always_covered": "",
            "years_listed": "",
            "years_reported": "",
            "nearest_listed": near,
            "likely_match": likely,
        })

    order = ["not_on_list", "not_on_list_adjacent", "excluded_assessor_10k", "assessor_under_10k",
             "excluded_assessor_small", "no_assessor_size"]
    rows.sort(key=lambda r: (order.index(r["issue"]), -(r["assessor_sf"] or 0)))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    covered = [b for b in buildings.values() if b["covered"]]
    sized = [b for b in covered if b["assessor_sf"]]
    print(f"wrote {OUT}")
    print(f"covered buildings on site: {len(covered)}; with an Assessor size: {len(sized)}")
    for issue in order:
        print(f"  {issue}: {sum(r['issue'] == issue for r in rows)}")
    print(f"  (not_on_list* rows with a likely_match: {sum(bool(r['likely_match']) for r in rows)})")


if __name__ == "__main__":
    main()
