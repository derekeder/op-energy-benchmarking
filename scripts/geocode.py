"""Geocode benchmarking addresses with the US Census batch geocoder.

Reads every data/op-benchmarking-*.csv, collects the unique "CPL Property Address"
values, and writes data/geocoded.csv (address, latitude, longitude, match).
Addresses already in data/geocoded.csv are skipped, so re-running only geocodes
new ones.

Usage: python3 scripts/geocode.py
"""
import csv
import glob
import io
import os
import urllib.request
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(DATA, "geocoded.csv")
URL = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"
ADDRESS_COL = "CPL Property Address"
FIELDS = ["address", "latitude", "longitude", "match"]


def source_addresses():
    addresses = set()
    for path in sorted(glob.glob(os.path.join(DATA, "op-benchmarking-*.csv"))):
        with open(path, encoding="utf-8-sig", newline="") as f:
            for row in csv.DictReader(f):
                a = row[ADDRESS_COL].strip()
                if a:
                    addresses.add(a)
    return addresses


def existing():
    if not os.path.exists(OUT):
        return {}
    with open(OUT, encoding="utf-8", newline="") as f:
        return {r["address"]: r for r in csv.DictReader(f)}


def batch_geocode(addresses):
    """Return {address: row}. Batch limit is 10,000 addresses per request."""
    buf = io.StringIO()
    w = csv.writer(buf)
    ids = {}
    for i, a in enumerate(sorted(addresses)):
        ids[str(i)] = a
        w.writerow([i, a, "Oak Park", "IL", ""])

    boundary = uuid.uuid4().hex
    body = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="benchmark"\r\n\r\n'
        "Public_AR_Current\r\n"
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="addressFile"; filename="addresses.csv"\r\n'
        "Content-Type: text/csv\r\n\r\n"
        f"{buf.getvalue()}\r\n"
        f"--{boundary}--\r\n"
    ).encode("utf-8")
    req = urllib.request.Request(
        URL, data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=600) as resp:
        text = resp.read().decode("utf-8")

    results = {}
    # Columns: id, input, Match/No_Match/Tie, Exact/Non_Exact, matched address,
    # "lon,lat", tiger line id, side
    for row in csv.reader(io.StringIO(text)):
        if not row or row[0] not in ids:
            continue
        a = ids[row[0]]
        lat = lng = ""
        status = row[2] if len(row) > 2 else "No_Match"
        if status == "Match" and len(row) > 5 and row[5]:
            lng, lat = row[5].split(",")
            status = row[3]  # Exact / Non_Exact
        results[a] = {"address": a, "latitude": lat, "longitude": lng, "match": status}
    return results


def main():
    done = existing()
    todo = source_addresses() - set(done)
    print(f"{len(done)} already geocoded, {len(todo)} to geocode")
    if todo:
        done.update(batch_geocode(todo))
    with open(OUT, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for a in sorted(done):
            w.writerow(done[a])
    matched = sum(1 for r in done.values() if r["latitude"])
    print(f"wrote {OUT}: {matched}/{len(done)} matched")
    for a in sorted(a for a, r in done.items() if not r["latitude"]):
        print("  unmatched:", a)


if __name__ == "__main__":
    main()
