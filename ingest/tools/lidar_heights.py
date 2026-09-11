#!/usr/bin/env python3
"""
lidar_heights.py — measure building heights from a USGS 3DEP lidar point cloud.

Invoked by ingest/src/sources/usgs-lidar-lpc.mjs. Kept in Python because reading
LAZ needs laspy and reprojecting needs pyproj, and neither has a usable pure-Node
equivalent. This is the only non-Node step in the ingest package; the adapter
declares it in `requires` and is optional in every world manifest.

Method, for each footprint:

  roof   = 50th percentile of returns inside the polygon, inset from its edge
  ground = 5th percentile of returns in an annulus just outside it
  height = roof - ground

Percentiles, not extremes, on purpose. The maximum return inside a footprint is a
rooftop mechanical penthouse, a parapet or a bird; the minimum is a return that
slipped through a light well to the floor below. Davis Library measures 172.05 m at
p50 and 178.79 m at the maximum — a 6.7 m difference that is real rooftop plant, not
the building's height. p50 finds the roof plane that a facade builder should extrude to.

The ground estimate uses p05 of the annulus rather than p50 because a building on a
slope has ground on several levels, and a reconstruction that sits the building on
the high side floats it. p05 approximates the low side.

I/O is JSON on stdin/stdout so the Node side stays in charge of caching and provenance.

  stdin : {"tiles": ["/path/a.laz"], "crs": "EPSG:32119",
           "buildings": [{"id": "way/1", "ring": [[lon,lat], ...]}]}
  stdout: {"heights": [{"id", "roofM", "groundM", "heightM", "points", "confidence"}], ...}
"""
import json
import sys

try:
    import numpy as np
    import laspy
    from pyproj import Transformer
except ImportError as e:  # pragma: no cover - surfaced to the Node adapter
    print(json.dumps({"error": f"missing python dependency: {e}. "
                               "pip install 'laspy[lazrs]' pyproj numpy"}))
    sys.exit(0)


def contains(poly, px, py):
    """Vectorised even-odd point-in-polygon. Avoids a matplotlib dependency."""
    n = len(poly)
    inside = np.zeros(len(px), bool)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        cond = (yi > py) != (yj > py)
        denom = yj - yi
        denom = denom if denom != 0 else 1e-12
        xint = (xj - xi) * (py - yi) / denom + xi
        inside ^= cond & (px < xint)
        j = i
    return inside


def shrink(poly, metres):
    """
    Pull a ring towards its centroid by roughly `metres`.

    Returns near a facade are a mess: wall hits, ledges, and points whose horizontal
    error straddles the edge. Insetting a couple of metres keeps the roof sample on
    the roof. Crude (centroid-scaled, not a true offset) but adequate for the
    compact footprints buildings actually have.
    """
    c = poly.mean(axis=0)
    d = poly - c
    r = np.hypot(d[:, 0], d[:, 1])
    scale = np.clip((r - metres) / np.where(r == 0, 1e-9, r), 0.0, 1.0)
    return c + d * scale[:, None]


def main():
    req = json.load(sys.stdin)
    tiles = req["tiles"]
    crs = req.get("crs") or "EPSG:32119"
    buildings = req["buildings"]
    inset_m = float(req.get("insetM", 2.5))
    annulus_m = float(req.get("annulusM", 25.0))
    min_points = int(req.get("minPoints", 30))

    to_crs = Transformer.from_crs("EPSG:4326", crs, always_xy=True)

    # Project every ring once.
    polys = {}
    for b in buildings:
        ring = b["ring"]
        xs, ys = to_crs.transform([p[0] for p in ring], [p[1] for p in ring])
        polys[b["id"]] = np.column_stack([xs, ys])

    # Accumulate returns per building across every tile, so a footprint straddling
    # a tile boundary is still measured from all of its points.
    acc = {b["id"]: {"roof": [], "ground": []} for b in buildings}
    tile_info = []

    for path in tiles:
        try:
            las = laspy.read(path)
        except Exception as e:
            tile_info.append({"tile": path, "error": str(e)})
            continue
        X = np.asarray(las.x)
        Y = np.asarray(las.y)
        Z = np.asarray(las.z)
        tile_info.append({"tile": path, "points": int(len(X))})

        for bid, poly in polys.items():
            x0, y0 = poly[:, 0].min(), poly[:, 1].min()
            x1, y1 = poly[:, 0].max(), poly[:, 1].max()
            m = (X >= x0 - annulus_m) & (X <= x1 + annulus_m) & \
                (Y >= y0 - annulus_m) & (Y <= y1 + annulus_m)
            if not m.any():
                continue
            Xm, Ym, Zm = X[m], Y[m], Z[m]
            ins_full = contains(poly, Xm, Ym)
            ins_roof = contains(shrink(poly, inset_m), Xm, Ym)
            acc[bid]["roof"].append(Zm[ins_roof])
            acc[bid]["ground"].append(Zm[~ins_full])

    out = []
    for b in buildings:
        bid = b["id"]
        roof = np.concatenate(acc[bid]["roof"]) if acc[bid]["roof"] else np.array([])
        ground = np.concatenate(acc[bid]["ground"]) if acc[bid]["ground"] else np.array([])
        if len(roof) < min_points or len(ground) < min_points:
            out.append({
                "id": bid, "heightM": None, "points": int(len(roof)),
                "reason": f"too few returns (roof {len(roof)}, ground {len(ground)}; need {min_points})",
            })
            continue
        roof_m = float(np.percentile(roof, 50))
        roof_max = float(roof.max())
        ground_m = float(np.percentile(ground, 5))
        h = roof_m - ground_m
        # A negative or absurd height means the footprint and the point cloud
        # disagree about where the building is — usually a demolished or
        # post-survey building. Report it rather than emitting a bad number.
        ok = 1.5 <= h <= 400
        out.append({
            "id": bid,
            "roofM": round(roof_m, 2),
            "roofMaxM": round(roof_max, 2),
            "groundM": round(ground_m, 2),
            "heightM": round(h, 2) if ok else None,
            "rooftopPlantM": round(roof_max - roof_m, 2),
            "points": int(len(roof)),
            "groundPoints": int(len(ground)),
            # Point count is the honest confidence signal: a roof sampled by 8,000
            # returns is a measurement, one sampled by 40 is an estimate.
            "confidence": "high" if len(roof) >= 500 else "medium" if len(roof) >= 120 else "low",
            **({} if ok else {"reason": f"implausible derived height {h:.1f} m"}),
        })

    json.dump({"heights": out, "tiles": tile_info, "crs": crs}, sys.stdout)


if __name__ == "__main__":
    main()
