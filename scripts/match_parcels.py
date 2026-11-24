"""Match benchmarking addresses to Cook County parcel shapes.

Inputs
  data/op-benchmarking-*.csv          benchmarking exports ("CPL Property Address")
  data/ccgisdata_-_Parcel_*.geojson   Cook County parcel polygons (keyed by pin10)
  data/parcel_addresses.csv           pin10 -> property address, from the Cook County
                                      Assessor "Parcel Addresses" dataset (3723-97qp).
                                      Downloaded automatically if missing.
  data/address_corrections.csv        hand-reviewed fixes: address, corrected_address,
                                      pins (space-separated pin10s), note. "pins" assigns
                                      parcels directly (e.g. tax-exempt public buildings
                                      with no Assessor address); otherwise
                                      corrected_address is matched instead of the original.

Output
  data/parcels.geojson   one feature per benchmarking address, with the matching
                         parcel polygons merged into a MultiPolygon. Properties:
                         address, pins, match ("exact", "nearby" or "manual").

Matching
  1. exact:  the normalized address (number + street, unit dropped) equals an
             Assessor property address.
  2. nearby: otherwise, the parcel on the same street and side (same odd/even
             house number) with the closest house number, within MAX_GAP.
             This catches buildings that span an address range.
  Either way, candidate parcels more than MAX_DISTANCE meters from the address's
  geocoded point (data/geocoded.csv) are dropped, which guards against bad
  Assessor records. Addresses with no match stay as geocoded points on the map.

Usage: python3 scripts/match_parcels.py
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
ADDRESSES = os.path.join(DATA, "parcel_addresses.csv")
OUT = os.path.join(DATA, "parcels.geojson")
ASSESSOR_URL = "https://datacatalog.cookcountyil.gov/resource/3723-97qp.csv"
ASSESSOR_YEARS = ["2025", "2026"]
MAX_GAP = 20  # max house-number distance for a "nearby" match
MAX_DISTANCE = 250  # meters between a parcel and the address's geocoded point
GEOCODED = os.path.join(DATA, "geocoded.csv")
CORRECTIONS = os.path.join(DATA, "address_corrections.csv")

SUFFIXES = {"AVE", "ST", "BLVD", "RD", "CT", "PL", "LN", "DR", "PKWY", "TER",
            "WAY", "CIR", "SQ", "PLZ", "HWY"}


SUFFIX_ALIASES = {"AV": "AVE", "AVENUE": "AVE", "BVD": "BLVD", "BOULEVARD": "BLVD",
                  "STREET": "ST", "ROAD": "RD", "COURT": "CT", "PLACE": "PL"}


def normalize(address):
    """'412 N. Taylor Ave. #2' -> ('412', 'N TAYLOR AVE'). Returns (None, None) if unparseable.

    Suffix spellings are standardized and a leading W/E is dropped (the Assessor
    data mixes "W WASHINGTON BLVD" and "WASHINGTON BLVD").
    """
    tokens = re.sub(r"[.,#]", " ", address.upper()).split()
    if not tokens or not re.match(r"^\d+", tokens[0]):
        return None, None
    number = re.match(r"^\d+", tokens[0]).group(0)
    street = []
    for t in tokens[1:]:
        t = SUFFIX_ALIASES.get(t, t)
        if not street and t in ("W", "E"):
            continue
        street.append(t)
        if t in SUFFIXES:
            break
    return number, " ".join(street)


def centroid(geom):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    pts = [p for poly in polys for p in poly[0]]
    return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)


def meters(a, b):
    # equirectangular approximation, fine at village scale (~41.9°N)
    return math.hypot((a[0] - b[0]) * 83000, (a[1] - b[1]) * 111000)


def load_geocoded():
    points = {}
    if os.path.exists(GEOCODED):
        with open(GEOCODED, encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                if r["latitude"]:
                    points[r["address"]] = (float(r["longitude"]), float(r["latitude"]))
    return points


def load_corrections():
    corrections = {}
    if os.path.exists(CORRECTIONS):
        with open(CORRECTIONS, encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                corrections[r["address"].strip()] = {
                    "address": (r["corrected_address"] or "").strip(),
                    "pins": set((r["pins"] or "").split()),
                }
    return corrections


def download_addresses():
    rows = []
    for year in ASSESSOR_YEARS:
        params = urllib.parse.urlencode({
            "$select": "pin10,prop_address_full",
            "$where": f"prop_address_city_name='OAK PARK' AND year='{year}'",
            "$limit": "100000",
        })
        with urllib.request.urlopen(f"{ASSESSOR_URL}?{params}", timeout=300) as resp:
            rows.extend(csv.DictReader(resp.read().decode("utf-8").splitlines()))
    seen = set()
    with open(ADDRESSES, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["pin10", "address"])
        for r in rows:
            k = (r["pin10"], r["prop_address_full"])
            if k not in seen and r["prop_address_full"]:
                seen.add(k)
                w.writerow(k)
    print(f"downloaded {len(seen)} parcel addresses -> {ADDRESSES}")


def main():
    parcel_files = sorted(glob.glob(os.path.join(DATA, "ccgisdata_-_Parcel_*.geojson")))
    if not parcel_files:
        raise SystemExit("no data/ccgisdata_-_Parcel_*.geojson found")
    with open(parcel_files[-1], encoding="utf-8") as f:
        geometry = {ft["properties"]["pin10"]: ft["geometry"] for ft in json.load(f)["features"]}

    if not os.path.exists(ADDRESSES):
        download_addresses()

    exact = {}      # "412 N TAYLOR AVE" -> {pin10}
    by_street = {}  # "N TAYLOR AVE" -> [(412, pin10)]
    with open(ADDRESSES, encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            if r["pin10"] not in geometry:
                continue
            number, street = normalize(r["address"])
            if not number:
                continue
            exact.setdefault(f"{number} {street}", set()).add(r["pin10"])
            by_street.setdefault(street, []).append((int(number), r["pin10"]))

    addresses = set()
    for path in glob.glob(os.path.join(DATA, "op-benchmarking-*.csv")):
        with open(path, encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                if r["CPL Property Address"].strip():
                    addresses.add(r["CPL Property Address"].strip())

    points = load_geocoded()
    centroids = {}

    def close(pin, address):
        if address is None or address not in points:
            return True
        if pin not in centroids:
            centroids[pin] = centroid(geometry[pin])
        return meters(centroids[pin], points[address]) <= MAX_DISTANCE

    corrections = load_corrections()
    for address, c in corrections.items():
        # Several PINs may be listed (e.g. a current PIN and its predecessor in an
        # older parcel layer); only warn when none of them have a shape.
        if c["pins"] and not c["pins"] & set(geometry):
            print(f"  warning: {address}: no pins found in parcel file: {' '.join(sorted(c['pins']))}")

    features, counts, unmatched = [], {"exact": 0, "nearby": 0, "manual": 0}, []
    for address in sorted(addresses):
        fix = corrections.get(address, {})
        lookup = fix.get("address") or address
        # A hand correction is trusted, so it skips the distance guard
        # (the geocoded point for a misspelled address may itself be off).
        guard = address if not fix else None
        number, street = normalize(lookup)
        pins, how = set(), None
        if fix.get("pins"):
            pins, how = fix["pins"] & set(geometry), "manual"
        elif number:
            pins = {p for p in exact.get(f"{number} {street}", set()) if close(p, guard)}
            how = "exact"
            if not pins:
                n = int(number)
                candidates = [(abs(num - n), pin) for num, pin in by_street.get(street, [])
                              if num % 2 == n % 2 and abs(num - n) <= MAX_GAP and close(pin, guard)]
                if candidates:
                    best = min(c[0] for c in candidates)
                    pins = {pin for gap, pin in candidates if gap == best}
                    how = "nearby"
        if not pins:
            unmatched.append(address)
            continue
        counts[how] += 1
        polygons = []
        for pin in sorted(pins):
            g = geometry[pin]
            polygons.extend(g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]])
        polygons = [[[[round(x, 6), round(y, 6)] for x, y, *_ in ring] for ring in poly] for poly in polygons]
        features.append({
            "type": "Feature",
            "properties": {"address": address, "pins": sorted(pins), "match": how},
            "geometry": {"type": "MultiPolygon", "coordinates": polygons},
        })

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f, separators=(",", ":"))
    print(f"wrote {OUT}: {counts['exact']} exact, {counts['nearby']} nearby, {counts['manual']} manual, "
          f"{len(unmatched)} unmatched of {len(addresses)} addresses")
    for a in unmatched:
        print("  unmatched:", a)


if __name__ == "__main__":
    main()
