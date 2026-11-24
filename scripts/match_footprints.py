"""Find the building footprints on each matched parcel.

Inputs
  data/overture/buildings.geojson   Overture Maps building footprints for Oak Park
                                    (mostly OpenStreetMap). Download it with:
                                      docker run --rm -v "$PWD/data/overture:/out" python:3.12-slim sh -c \
                                        "pip install -q overturemaps && overturemaps download \
                                         --bbox=-87.8100,41.8620,-87.7700,41.9120 -f geojson \
                                         --type=building -o /out/buildings.geojson"
  data/parcels.geojson              benchmarking addresses -> parcels (scripts/match_parcels.py)
  data/unlisted_buildings.geojson   unlisted Assessor buildings (scripts/assessor_review.py)

Output
  data/footprints.geojson   one feature per parcel match that has footprints, merged
                            into a MultiPolygon. Properties: key (the benchmarking
                            address, or the unlisted building id), kind ("listed" or
                            "unlisted"), count, area_sqft (footprint area, not floor
                            area), clipped (true if any piece was cut at the parcel line),
                            overture_ids.

Matching
  whole:    a footprint with at least MIN_INSIDE of its area inside the parcel is kept
            whole. Parcel lines are approximate, so a small overhang is expected.
  clipped:  a footprint mostly outside the parcel is cut at the parcel line when the
            piece inside covers at least MIN_PARCEL_SHARE of the parcel. This handles
            commercial blocks mapped as one footprint across several lots.
  The largest piece is always kept. Other pieces are kept if they're at least MIN_AREA
  and not tagged as a garage, which drops detached garages. Bleachers, canopies,
  carports and sheds are never used.

Size check
  A match is dropped when the building's floor area (the larger of the Assessor's and
  the self-reported) is over MAX_RATIO times the footprint area times its floor count,
  estimated from the footprint's lidar height (FLOOR_HEIGHT per floor, DEFAULT_FLOORS
  when there's no height). That catches parcels where only a booth or a neighbor's
  sliver is mapped while the building itself is missing from OpenStreetMap.

Parcels with no footprint get no feature, and the site falls back to the parcel shape.

Requires shapely (pip install shapely).
Usage: python3 scripts/match_footprints.py
"""
import csv
import glob
import json
import math
import os

import shapely
from shapely.geometry import mapping, shape
from shapely.ops import unary_union
from shapely.strtree import STRtree
from shapely.validation import make_valid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
BUILDINGS = os.path.join(DATA, "overture", "buildings.geojson")
PARCELS = os.path.join(DATA, "parcels.geojson")
UNLISTED = os.path.join(DATA, "unlisted_buildings.geojson")
OUT = os.path.join(DATA, "footprints.geojson")
SIZES = os.path.join(DATA, "assessor_sizes.csv")

MIN_INSIDE = 0.5         # share of a footprint inside the parcel to keep it whole
MIN_PARCEL_SHARE = 0.25  # share of the parcel a clipped piece must cover
MIN_AREA = 100           # m² (~1,100 ft²); smaller extra pieces are dropped
# Structures that are never a benchmarked building (bleachers, canopies, sheds) are
# ignored outright; garages are only dropped as extra pieces, since a parking garage
# can be the building itself.
NOT_BUILDINGS = {"stadium", "grandstand", "carport", "shed", "roof", "shelter", "hut", "kiosk"}
SKIP_EXTRA = NOT_BUILDINGS | {"garage", "garages"}
SQFT_PER_M2 = 10.7639
MAX_RATIO = 10           # floor area / (footprint x floors) above this is a bad match
FLOOR_HEIGHT = 3.5       # meters per floor
DEFAULT_FLOORS = 2       # when the footprint has no height

# Local equirectangular projection to meters, for areas only.
LAT0 = 41.887
MX = 111320 * math.cos(math.radians(LAT0))
MY = 110540


def area(geom):
    return shapely.transform(geom, lambda xy: xy * [MX, MY]).area


def polygons(geom):
    if geom.is_empty:
        return []
    if geom.geom_type == "Polygon":
        return [geom]
    if hasattr(geom, "geoms"):
        return [p for g in geom.geoms for p in polygons(g)]
    return []  # lines and points left over from clipping


def load_footprints():
    with open(BUILDINGS) as f:
        features = json.load(f)["features"]
    out = []
    for f in features:
        p = f["properties"]
        if p.get("is_underground") or p.get("class") in NOT_BUILDINGS:
            continue
        geom = make_valid(shape(f["geometry"]))
        out.append({"id": p.get("id") or f.get("id"), "cls": p.get("class"), "geom": geom,
                    "area": area(geom), "height": p.get("height")})
    return out


def floor_areas():
    """Largest known floor area (ft²) by benchmarking address and unlisted id."""
    sizes = {}
    with open(SIZES) as f:
        for r in csv.DictReader(f):
            if r["assessor_sf"]:
                sizes[r["feature_id"]] = float(r["assessor_sf"])
    out = {}
    for path in glob.glob(os.path.join(DATA, "op-benchmarking-*.csv")):
        with open(path, encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                address = r["CPL Property Address"].strip()
                try:
                    gfa = float(r["Property GFA - Self-Reported (ft²)"])
                except ValueError:
                    gfa = 0
                out[address] = max(out.get(address, 0), gfa, sizes.get(r["Oak Park Feature ID"], 0))
    with open(UNLISTED) as f:
        for feat in json.load(f)["features"]:
            out[feat["properties"]["id"]] = feat["properties"].get("assessor_sf") or 0
    return out


def capacity(pieces):
    """Footprint area (ft²) times estimated floors, summed over pieces."""
    total = 0
    for piece in pieces:
        h = piece[5]
        floors = max(1, round(h / FLOOR_HEIGHT)) if h else DEFAULT_FLOORS
        total += piece[1] * SQFT_PER_M2 * floors
    return total


def match(parcel_geom, footprints, tree):
    """Returns [(geometry, area_m2, overture_id, class, clipped, height)] for one parcel."""
    parcel = make_valid(shape(parcel_geom))
    parcel_area = area(parcel)
    pieces = []
    for n in tree.query(parcel, predicate="intersects"):
        fp = footprints[n]
        inside = fp["geom"].intersection(parcel)
        inside_area = area(inside)
        if fp["area"] and inside_area / fp["area"] >= MIN_INSIDE:
            pieces.append((fp["geom"], fp["area"], fp["id"], fp["cls"], False, fp["height"]))
        elif inside_area >= MIN_PARCEL_SHARE * parcel_area:
            clipped = unary_union(polygons(inside))
            if not clipped.is_empty:
                pieces.append((clipped, inside_area, fp["id"], fp["cls"], True, fp["height"]))
    if not pieces:
        return []
    pieces.sort(key=lambda p: -p[1])
    return [pieces[0]] + [p for p in pieces[1:] if p[1] >= MIN_AREA and p[3] not in SKIP_EXTRA]


def feature(key, kind, pieces):
    polys = [p for piece in pieces for p in polygons(piece[0])]
    geom = mapping(unary_union(polys)) if len(polys) > 1 else mapping(polys[0])
    coords = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    return {
        "type": "Feature",
        "geometry": {"type": "MultiPolygon", "coordinates": coords},
        "properties": {"key": key, "kind": kind, "count": len(pieces),
                       "area_sqft": round(sum(p[1] for p in pieces) * SQFT_PER_M2),
                       "clipped": any(p[4] for p in pieces),
                       "overture_ids": [p[2] for p in pieces]},
    }


def main():
    footprints = load_footprints()
    tree = STRtree([fp["geom"] for fp in footprints])
    sizes = floor_areas()
    out, missing, too_small = [], [], []
    for path, kind, key_prop in [(PARCELS, "listed", "address"), (UNLISTED, "unlisted", "id")]:
        with open(path) as f:
            for parcel in json.load(f)["features"]:
                if not parcel["geometry"]:
                    continue
                key = parcel["properties"][key_prop]
                pieces = match(parcel["geometry"], footprints, tree)
                if pieces and sizes.get(key, 0) > MAX_RATIO * capacity(pieces):
                    too_small.append((kind, key, sizes[key], round(sum(p[1] for p in pieces) * SQFT_PER_M2)))
                    continue
                if pieces:
                    out.append(feature(key, kind, pieces))
                else:
                    missing.append((kind, key))
    for f in out:
        g = f["geometry"]
        g["coordinates"] = [[[[round(x, 7), round(y, 7)] for x, y in ring] for ring in poly]
                            for poly in g["coordinates"]]
    with open(OUT, "w") as f:
        json.dump({"type": "FeatureCollection", "features": out}, f, separators=(",", ":"))
    clipped = [f["properties"]["key"] for f in out if f["properties"]["clipped"]]
    print("%d parcel matches with footprints (%d clipped at the parcel line), %d without, "
          "%d dropped by the size check" % (len(out), len(clipped), len(missing), len(too_small)))
    for kind, key, sf, fp_sf in too_small:
        print("  too small: %s %s (floor area %d ft², footprint %d ft²)" % (kind, key, sf, fp_sf))
    for kind, key in missing:
        print("  no footprint: %s %s" % (kind, key))


if __name__ == "__main__":
    main()
