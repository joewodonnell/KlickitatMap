"""Classify parcel ownership, cross-check against PAD-US, and write the app's data files."""
import csv
import datetime
import json
import re
from collections import Counter
from pathlib import Path

from shapely.geometry import shape
from shapely.strtree import STRtree

HERE = Path(__file__).parent
RAW = HERE / "raw"
OUT = HERE / "out"
APP_DATA = HERE.parent / "docs" / "data"

CODES = {"public_federal": "pf", "public_state": "ps", "tribal": "t", "other_public": "op", "private": "p", "unknown": "u"}
PUBLIC = {"public_federal", "public_state"}


def load_rules():
    with open(HERE / "owner_rules.csv", newline="", encoding="utf-8") as f:
        return [(r["field"], re.compile(r["pattern"], re.I), r["land_class"], r["label"]) for r in csv.DictReader(f)]


def load_overrides():
    path = HERE / "parcel_overrides.csv"
    if not path.exists():
        return {}
    with open(path, newline="", encoding="utf-8") as f:
        return {r["parcel_num"].strip(): (r["land_class"].strip(), r.get("note", "").strip()) for r in csv.DictReader(f)}


def classify(props, rules):
    for field, pattern, land_class, label in rules:
        if pattern.search((props.get(field) or "").strip()):
            return land_class, label
    return "private", ""


def text(v):
    v = (v or "").strip()
    return v if v and not v.startswith("<") else ""


def clean_geometry(g):
    """Drop empty polygon parts in place; return False if nothing is left."""
    if not g:
        return False
    if g["type"] == "Polygon":
        return bool(g["coordinates"] and g["coordinates"][0])
    g["coordinates"] = [p for p in g["coordinates"] if p and p[0]]
    if len(g["coordinates"]) == 1:
        g["type"], g["coordinates"] = "Polygon", g["coordinates"][0]
    return bool(g["coordinates"])


def to_float(v):
    try:
        return round(float(v), 2)
    except (TypeError, ValueError):
        return None


def main():
    rules = load_rules()
    overrides = load_overrides()
    parcels = [f for f in json.loads((RAW / "parcels.geojson").read_text(encoding="utf-8"))["features"]
               if clean_geometry(f["geometry"])]
    padus = [f for f in json.loads((RAW / "padus.geojson").read_text(encoding="utf-8"))["features"]
             if f["geometry"] and f["properties"]["Own_Type"] in ("FED", "STAT")]
    meta_path = APP_DATA / "meta.json"
    if meta_path.exists():
        previous = json.loads(meta_path.read_text(encoding="utf-8"))["count"]
        if len(parcels) < 0.9 * previous:
            raise SystemExit(f"Only {len(parcels)} parcels downloaded (last build had {previous}); refusing to publish.")
    if not padus:
        raise SystemExit("No PAD-US public lands downloaded; refusing to publish.")
    pad_geoms = [shape(f["geometry"]).buffer(0) for f in padus]
    tree = STRtree(pad_geoms)

    out_features, review, stats = [], [], Counter()
    for i, f in enumerate(parcels):
        p = f["properties"]
        land_class, label = classify(p, rules)
        reason = ""

        pt = shape(f["geometry"]).representative_point()
        hits = [padus[j]["properties"] for j in tree.query(pt) if pad_geoms[j].contains(pt)]
        pad = hits[0] if hits else None

        if land_class in PUBLIC and not pad:
            reason = "Owner looks public, but PAD-US has no public land here"
        elif land_class == "private" and pad:
            reason = f"Owner looks private, but PAD-US says {pad['Own_Name']} ({pad['Unit_Nm']})"

        pn = (p.get("PARCEL_NUM") or "").strip()
        if pn in overrides:
            land_class, note = overrides[pn]
            label = note or label
            reason = ""

        if reason:
            review.append({"parcel_num": pn, "owner": p.get("NAME"), "address": p.get("ADDRESS"),
                           "rule_class": land_class, "padus_owner": pad["Own_Name"] if pad else "",
                           "padus_unit": pad["Unit_Nm"] if pad else "", "reason": reason})
            stats[f"review:{land_class}"] += 1
            land_class = "unknown"
        stats[land_class] += 1

        props = {
            "p": pn, "o": text(p.get("NAME")), "a": text(p.get("ADDRESS")), "l": text(p.get("LEGAL")),
            "ac": to_float(p.get("ACRES")), "v": p.get("TOTAL_AV"), "lv": p.get("LAND"), "iv": p.get("IMPRV"),
            "u": text(p.get("USECODE")), "c": CODES[land_class],
        }
        if label:
            props["g"] = label
        if reason:
            props["r"] = reason
        out_features.append({"type": "Feature", "id": i, "properties": props, "geometry": f["geometry"]})

    APP_DATA.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(exist_ok=True)
    (APP_DATA / "parcels.json").write_text(
        json.dumps({"type": "FeatureCollection", "features": out_features}, separators=(",", ":")), encoding="utf-8")
    county = json.loads((RAW / "county.geojson").read_text(encoding="utf-8"))
    (APP_DATA / "county.json").write_text(json.dumps(county, separators=(",", ":")), encoding="utf-8")
    meta = {"built": datetime.date.today().isoformat(), "count": len(out_features), "classes": dict(stats)}
    (APP_DATA / "meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")

    with open(OUT / "review.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["parcel_num", "owner", "address", "rule_class", "padus_owner", "padus_unit", "reason"],
                           lineterminator="\n")
        w.writeheader()
        w.writerows(review)

    for k, v in sorted(stats.items()):
        print(f"{k:24} {v}")
    print(f"wrote {len(out_features)} parcels, {len(review)} flagged for review -> {OUT / 'review.csv'}")


if __name__ == "__main__":
    main()
