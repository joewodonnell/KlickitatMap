# Klickitat Parcel Map — iOS App Plan

> **Status (2026-11-15):** Built as a free web app (PWA) instead of a native iOS app, to avoid the Apple developer fee. The app is in `docs/` (served by GitHub Pages); the data pipeline is in `pipeline/` (`python fetch.py && python build.py`). A GitHub Action (`.github/workflows/refresh-data.yml`) re-runs the pipeline on the 1st of each month and republishes only if the parcels changed; run it by hand from the repo's Actions tab. Everything below works except screen-off background tracking, which iPhone web apps can't do.

## The problem
The [Klickitat County interactive parcel map](https://imap.klickitatcounty.gov) shows parcel boundaries and who owns each parcel. It does **not** show where you are. When you're out on public land trying to stay off private property, you have to keep switching between the parcel map and Google Maps.

## What the app does
Everything the county map does, plus your live location, color-coded by land status:

| Dot | Meaning |
|---|---|
| 🟢 **Green** | You're on public land (DNR, WDFW, State Parks, USFS, BLM, etc.) or on a private parcel you've marked **Allowed**, and more than 50 ft from any off-limits boundary |
| 🟡 **Yellow** | You're on the public/allowed side but **within 50 ft** of an off-limits private boundary |
| 🔴 **Red** | You're inside a private parcel that isn't marked Allowed |
| ⚪ **Gray** | Status unknown: no GPS fix, GPS too inaccurate, or you're on a parcel whose ownership is still unclassified (see below) |

Gaps between parcels, such as road rights-of-way and rivers, count as public: the dot is green there, unless you're within 50 ft of an off-limits edge, which makes it yellow.

You can mark any private parcel **Allowed** (with an optional note, such as who gave permission and when it expires). The app then treats it like public land.

It **works fully offline**, since there's often no cell signal in the places you'll use it.

## Matching the county map's functionality
- Parcel boundaries over streets, topo, or aerial imagery
- Tap a parcel to see its owner, parcel #, acres, address, land use, and assessed value, with a link to the Assessor page
- Search by parcel #, owner, or address
- Measure distance and area
- *(Phase 0 task: browse the county map and list every layer and tool it has, such as zoning, sections/townships, roads, and contours, so nothing is missed.)*

## Architecture

```
 Mac (Python data pipeline)                         iPhone (SwiftUI app)
 ──────────────────────────                         ─────────────────────────────────
 County parcels ─┐                                   parcels.pmtiles → MapLibre map
 PAD-US / DNR ───┼─► classify ownership ─► build ─►  parcels.sqlite  → details, search,
 public lands    ┘   (public/private/tribal)                            location status engine
                                                     SwiftData       → Allowed list, notes
```

| Concern | Choice | Why |
|---|---|---|
| UI | SwiftUI (iOS 17+) | Modern and needs little boilerplate |
| Map | **MapLibre Native iOS** | Free. It draws about 21k parcels smoothly from offline vector tiles, and the styling can change live, e.g. recoloring a parcel the moment you mark it Allowed. |
| Parcel shapes on the map | **PMTiles** built with `tippecanoe` | A single offline file |
| Parcel data and geometry | **SQLite** via GRDB.swift, with an R*Tree spatial index | Fast "which parcel am I in?" and "what's within 50 ft?" lookups |
| User data | SwiftData | Allowed parcels, notes, favorites |
| Location | Core Location | Live position and accuracy |
| Pipeline | Python + GeoPandas/GDAL + `tippecanoe` | Standard GIS tools |

## Core feature: the location status engine

### 1. Classifying ownership (done in the pipeline, on your Mac)
The county data lists an **owner name** for each parcel, not whether the land is public. The pipeline gives every parcel a `land_class`:
- **public_state:** owner matches patterns like `STATE OF WASHINGTON`, `DEPT OF NATURAL RESOURCES`, `DNR`, `WDFW`, `FISH & WILDLIFE`, `STATE PARKS`
- **public_federal:** `UNITED STATES`, `USDA FOREST SERVICE`, `BUREAU OF LAND MGMT`, `ARMY CORPS`, `US FISH & WILDLIFE`
- **tribal:** Yakama Nation / BIA trust land. Off-limits (red dot), drawn in its own purple color on the map.
- **other_public:** county, city, school district, port, PUD. Off-limits (red dot) by default. You can mark individual parcels Allowed.
- **private:** everything else

Each parcel's class is **cross-checked against the USGS Protected Areas Database (PAD-US) and the WA DNR managed-lands layer**, since owner names are messy. Where the two disagree, the parcel is flagged for review. The app shows these flagged parcels in gray until you resolve them.

The rules live in a small, editable `owner_rules.csv`, so you can fix a misclassified owner and re-run the pipeline. You can also override a parcel's class inside the app.

### 2. Working out the dot color (on the phone, every GPS update)
```
fix = latest GPS location (lat, lon, horizontal accuracy in ft)
if no fix or accuracy > 100 ft          → GRAY ("weak GPS")
parcel = parcel containing fix (R*Tree bounding-box search, then point-in-polygon)
if parcel is unclassified               → GRAY
if parcel is off-limits                 → RED
(no parcel = road right-of-way, river, or a data gap → treated as public; continue)
offLimitsNearby = off-limits parcels whose bounding box is within (50 ft + accuracy)
d = shortest distance from fix to any of their edges (in a local flat projection, in feet)
if d ≤ 50 ft + accuracy                 → YELLOW
else                                    → GREEN
```
"Off-limits" means private, tribal, or other_public, and not on your Allowed list.

**GPS uncertainty is built in.** Phone GPS is typically accurate to 15–30 ft, and worse under tree cover. The yellow band therefore grows with the current accuracy, so the app errs toward warning you. The map also shows an accuracy circle around the dot.

Each check only touches a few nearby polygons, so it takes well under a millisecond and can run on every location update.

### 3. Alerts (recommended)
- A haptic buzz and sound when the status changes **to yellow or red**
- An optional "tracking mode" that keeps checking with the screen off, using background location. It sends a lock-screen notification when you cross into yellow or red.
- A banner at the top of the screen: e.g. "DNR land · 120 ft to private boundary (N. Smith)"

### 4. Allowed parcels
- Tap a parcel and choose **Mark as Allowed**. You can add a note ("Permission from owner, Oct 2026") and an optional expiry date.
- Allowed parcels get a distinct outline color on the map, and there's a list screen to manage them.
- Export and import the list, so it survives reinstalls and data updates. Parcels are matched by parcel #.

### Map styling for the use case
Fill colors at a glance:
- light green: public
- tinted with a bold outline: allowed
- light red: off-limits private
- purple: tribal
- gray: unknown

The colors show how the land around you is laid out even before you walk up to a boundary.

## ⚠️ Accuracy caveat
County GIS parcel lines are **not surveys**. In rural areas they are often off by 20–100+ ft from the real boundary, and phone GPS adds its own error. The app is a navigation aid, not a legal determination. Where they exist, posted signs, fences, and survey markers take precedence. The app shows this caveat once at first launch and keeps it in the About screen.

## Data sources (verify in Phase 0)

| Layer | Source | Notes |
|---|---|---|
| Parcels + owner names | Klickitat County GIS (the map's backend). It is probably an ArcGIS service, and the county may provide a download if asked. | Authoritative and exactly what the county map shows. Check the terms and how often it is updated. |
| Parcels fallback | WA statewide parcels (Ecology/OCIO), or Regrid / ReportAll (~$200) | The DNR/OCIO version has **no owner names** |
| Public land check | **PAD-US** (USGS), WA DNR managed lands, WDFW lands | Free. Used to validate the public/private classification. |
| Roads, water | Census TIGER/Line | Free basemap context |
| Basemap / topo / imagery | OpenFreeMap or Protomaps vector basemap, USGS topo & NAIP imagery | Imagery for offline use must be downloaded ahead of time for areas you plan to visit |

## Phased roadmap

| Phase | Deliverable | Effort |
|---|---|---|
| **0. Recon** | Catalog the county map's layers and tools, find its data service, get a full parcel download, inspect it in QGIS, pull PAD-US for the county | 1–2 evenings |
| **1. Pipeline** | Script producing `parcels.pmtiles` + `parcels.sqlite`, with `land_class` from owner rules + PAD-US cross-check, plus a review report of mismatches | 3 evenings |
| **2. Map on phone** | SwiftUI + MapLibre showing color-coded parcels offline, the blue location dot, and tap for parcel details | 3 evenings |
| **3. ⭐ Status engine** | Green/yellow/red/gray dot, accuracy circle, status banner, haptic alerts, unit tests with known points | 3 evenings |
| **4. Allowed parcels** | Mark/unmark, notes, expiry, list screen, export/import | 2 evenings |
| **5. Field test** | Walk known DNR/private boundaries. Tune the GPS accuracy thresholds and fix misclassified owners. | a weekend |
| **6. County-map parity** | Search, measure tool, extra layers found in Phase 0 | 3 evenings |
| **7. Background tracking** | Screen-off alerts with background location, with care for battery use | 2 evenings |
| **8. Polish** | Offline imagery download for chosen areas, About/disclaimer, data date, TestFlight | 2 evenings |

**First milestone: Phase 3.** At that point you can stand at a known DNR boundary and watch the dot change color. Everything after that is refinement.

## Decisions
1. **Roads and rivers:** gaps between parcels count as public (green), and the 50 ft yellow warning still applies near off-limits edges.
2. **Other public owners** (county, city, school, port, PUD): off-limits (red) by default. Individual parcels can be marked Allowed.
3. **Tribal land:** off-limits (red), drawn in its own purple color.
4. **Data updates:** once a year, re-run the pipeline on the Mac and reinstall the app. There's no in-app download.

## Project layout
```
KlickitatParcelMap/
  pipeline/                 # Python: fetch.py, classify.py, build.py, owner_rules.csv
    raw/  out/
  ios/KlickitatParcels/     # Xcode project
  PLAN.md
```

## Tools to install
- Xcode, signed in with an Apple ID. Free on-device builds expire after 7 days; TestFlight needs the $99/yr developer program.
- `brew install gdal tippecanoe` and `pip install geopandas pyogrio shapely`
- QGIS, for Phase 0 inspection
