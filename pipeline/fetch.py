"""Download Klickitat County parcels and PAD-US public lands into pipeline/raw/."""
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

RAW = Path(__file__).parent / "raw"
PARCELS = "https://geo.gartrellgroup.com/server/rest/services/Klickitat/Layers/MapServer/6/query"
COUNTY_LINE = "https://geo.gartrellgroup.com/server/rest/services/Klickitat/Layers/MapServer/1/query"
PADUS = "https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Manager_Name/FeatureServer/0/query"
BBOX = "-121.95,45.55,-120.0,46.25"
PAGE = 2000


def get(url, params):
    full = url + "?" + urllib.parse.urlencode(params)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(full, timeout=120) as r:
                data = json.load(r)
            if "error" in data:
                raise RuntimeError(data["error"])
            return data
        except Exception as e:
            if attempt == 3:
                raise
            print(f"  retry after {e}")
            time.sleep(3 * (attempt + 1))


def paged(url, params):
    features, offset = [], 0
    while True:
        page = get(url, {**params, "resultOffset": offset, "resultRecordCount": PAGE, "f": "geojson"})
        batch = page.get("features", [])
        features += batch
        print(f"  {len(features)} features")
        if len(batch) < PAGE and not page.get("exceededTransferLimit") and not page.get("properties", {}).get("exceededTransferLimit"):
            break
        offset += len(batch)
    return {"type": "FeatureCollection", "features": features}


def save(name, fc):
    RAW.mkdir(exist_ok=True)
    (RAW / name).write_text(json.dumps(fc), encoding="utf-8")


def main():
    print("Parcels")
    save("parcels.geojson", paged(PARCELS, {
        "where": "1=1", "outFields": "*", "outSR": 4326, "geometryPrecision": 6,
        "orderByFields": "OBJECTID",
    }))
    print("County boundary")
    save("county.geojson", paged(COUNTY_LINE, {"where": "1=1", "outFields": "*", "outSR": 4326, "geometryPrecision": 6}))
    print("PAD-US fee lands")
    save("padus.geojson", paged(PADUS, {
        "where": "Category='Fee'", "geometry": BBOX, "geometryType": "esriGeometryEnvelope", "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects", "outFields": "Own_Type,Own_Name,Mang_Name,Unit_Nm,Pub_Access",
        "outSR": 4326, "geometryPrecision": 6, "orderByFields": "OBJECTID",
    }))


if __name__ == "__main__":
    main()
