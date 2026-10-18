# Original stylised body figure for the Stats body maps: right half authored, mirrored.
# Units match BODY in public/app.js (origin top centre, ~204 x 458). Needs shapely.
# Run: python3 tools/body_figure.py  -> body.json, then paste its front/back strings into BODY in app.js.
import math, json
from shapely.geometry import Polygon, Point, MultiPolygon
from shapely.ops import unary_union
from shapely import affinity

def catmull(pts, n=8, closed=True):
    out = []; P = pts + pts[:3] if closed else pts
    rng = range(len(pts)) if closed else range(len(pts) - 3)
    for i in rng:
        p0, p1, p2, p3 = P[i], P[i + 1], P[i + 2], P[i + 3]
        for k in range(n):
            t = k / n; t2, t3 = t * t, t * t * t
            out.append(tuple(0.5 * ((2 * p1[j]) + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3) for j in range(len(p1))))
    return out

def smooth(pts): return Polygon(catmull(pts))
def mirror(g): return affinity.scale(g, -1, 1, origin=(0, 0))
def both(g): return unary_union([g, mirror(g)])

class Limb:
    """centreline [(x, y, width)], panels addressed by t (0..1 along) and s (-1 inner .. 1 outer)"""
    def __init__(self, pts, outer_sign=1):
        self.c = catmull([pts[0]] + pts + [pts[-1]], n=12, closed=False) + [pts[-1]]
        self.c = [tuple(p) for p in self.c]
        self.sgn = outer_sign
        L = [0]
        for a, b in zip(self.c, self.c[1:]): L.append(L[-1] + math.dist(a[:2], b[:2]))
        self.L = [l / L[-1] for l in L]
    def at(self, t, s):
        i = max(0, min(len(self.c) - 2, next((k for k, l in enumerate(self.L) if l >= t), len(self.L) - 1) - 1))
        a, b = self.c[i], self.c[i + 1]
        f = 0 if self.L[i + 1] == self.L[i] else (t - self.L[i]) / (self.L[i + 1] - self.L[i])
        x, y, w = (a[j] + (b[j] - a[j]) * f for j in range(3))
        dx, dy = b[0] - a[0], b[1] - a[1]; d = math.hypot(dx, dy) or 1
        nx, ny = dy / d, -dx / d          # normal; flip so +s points outward (away from body centre)
        if nx * self.sgn < 0: nx, ny = -nx, -ny
        return (x + nx * s * w / 2, y + ny * s * w / 2)
    def panel(self, t0, t1, s0=-1, s1=1, n=24):
        ts = [t0 + (t1 - t0) * k / n for k in range(n + 1)]
        return Polygon([self.at(t, s0) for t in ts] + [self.at(t, s1) for t in reversed(ts)])
    def shape(self): return self.panel(0, 1, n=60).buffer(0)

# ---------- silhouette (right half) ----------
head = affinity.scale(Point(0, 31).buffer(1, 64), 21, 29)
neck = Polygon([(0, 50), (12, 52), (14, 70), (22, 80), (0, 80)])
torso = smooth([(0, 76), (20, 78), (42, 84), (56, 92), (58, 104), (53, 128), (47, 150), (42, 176), (40, 200), (43, 222), (48, 242), (45, 258), (24, 268), (0, 270)])
arm = Limb([(62, 104, 31), (69, 134, 30), (75, 166, 24), (82, 198, 24), (90, 238, 15)], 1)
cap = Point(59, 106).buffer(17, 48)          # deltoid
hand = affinity.rotate(smooth([(0, 0), (7, 2), (9, 14), (7, 26), (0, 29), (-6, 23), (-7, 10), (-5, 2)]), -16, origin=(0, 0))
hand = affinity.translate(hand, 88, 234)
leg = Limb([(26, 248, 46), (30, 296, 42), (31, 338, 30), (32, 372, 32), (31, 400, 24), (30, 430, 16)], 1)
foot = smooth([(21, 426), (38, 426), (42, 444), (45, 454), (37, 459), (19, 459), (18, 444)])
right = unary_union([neck, torso, cap, arm.shape(), hand, leg.shape(), foot])
right = right.intersection(Polygon([(0, 0), (200, 0), (200, 500), (0, 500)]))
sil = unary_union([head, both(right)]).buffer(2).buffer(-2)
inner = sil.buffer(-2.8)            # rim of silhouette colour around the panels

GAP = 1.6
def finish(parts):
    """parts: [(muscle, right-side geometry)] in priority order -> {muscle: geometry both sides} with gaps"""
    used, out = None, {}
    for m, g in parts:
        g = g.intersection(inner)
        if used is not None: g = g.difference(used.buffer(GAP * 2))
        g = g.buffer(-0.01)
        if g.is_empty: continue
        used = g if used is None else unary_union([used, g])
        g = g.buffer(-2.4).buffer(2.4)               # round the corners
        out.setdefault(m, []).append(both(g) if m != 'neck' else g)
    return {m: unary_union(gs) for m, gs in out.items()}

P = Polygon
NECK = P([(0, 60), (10, 62), (11, 74), (4, 84), (0, 84)])
FOREARMS = [('forearms', arm.panel(0.54, 0.97, -1, -0.05)), ('forearms', arm.panel(0.54, 0.97, 0.05, 1))]
front = finish([
    ('neck', NECK.union(mirror(NECK))),
    ('traps', P([(11, 62), (15, 74), (46, 85), (42, 91), (18, 91)])),
    ('chest', smooth([(3, 95), (24, 93), (42, 95), (48, 104), (45, 122), (30, 132), (12, 132), (3, 128)])),
    ('frontDelt', cap.intersection(P([(30, 80), (60, 80), (68, 130), (30, 130)]))),
    ('sideDelt', cap.difference(P([(30, 80), (60, 80), (68, 130), (30, 130)]))),
    ('biceps', arm.panel(0.2, 0.51, -0.9, 0.9)),
    *FOREARMS,
    ('abs', P([(2, 138), (18, 136), (18, 152), (2, 154)])), ('abs', P([(2, 158), (19, 157), (19, 173), (2, 174)])),
    ('abs', P([(2, 178), (19, 178), (19, 194), (2, 194)])), ('abs', P([(2, 198), (19, 198), (17, 240), (8, 256), (2, 258)])),
    ('obliques', P([(24, 136), (46, 130), (44, 150), (24, 156)])), ('obliques', P([(24, 160), (44, 156), (42, 196), (24, 200)])),
    ('obliques', P([(24, 204), (42, 200), (48, 236), (24, 246)])),
    ('quads', leg.panel(0.03, 0.47, 0.42, 1)), ('quads', leg.panel(0.06, 0.47, -0.22, 0.42)), ('quads', leg.panel(0.28, 0.47, -0.7, -0.22)),
    ('adductors', leg.panel(0.03, 0.27, -1, -0.22)),
    ('calves', leg.panel(0.51, 0.93, 0.1, 1)), ('calves', leg.panel(0.53, 0.78, -1, 0.1)),
])
back = finish([
    ('traps', smooth([(2, 58), (10, 60), (14, 76), (44, 88), (28, 100), (14, 130), (6, 160), (2, 166)])),
    ('rearDelt', cap.difference(P([(30, 80), (50, 80), (52, 130), (30, 130)]))),
    ('upperBack', smooth([(30, 100), (46, 104), (52, 114), (48, 128), (34, 126), (24, 112)])),
    ('lats', smooth([(22, 132), (46, 130), (50, 140), (44, 166), (38, 196), (26, 206), (16, 176)])),
    ('lowerBack', P([(2, 172), (14, 180), (24, 212), (22, 244), (2, 246)])),
    ('obliques', P([(30, 206), (40, 198), (46, 236), (34, 240)])),
    ('triceps', arm.panel(0.2, 0.52, -1, 0.05)), ('triceps', arm.panel(0.16, 0.52, 0.05, 1)),
    *FOREARMS,
    ('glutes', smooth([(3, 252), (24, 248), (44, 254), (51, 272), (46, 292), (26, 298), (3, 294)])),
    ('hamstrings', leg.panel(0.23, 0.48, 0.02, 1)), ('hamstrings', leg.panel(0.25, 0.48, -0.66, -0.02)),
    ('adductors', leg.panel(0.23, 0.36, -1, -0.66)),
    ('calves', leg.panel(0.52, 0.74, -1, 0)), ('calves', leg.panel(0.52, 0.74, 0, 1)), ('calves', leg.panel(0.76, 0.93, -0.65, 0.65)),
])

def d(g, ox=0):
    polys = list(g.geoms) if hasattr(g, 'geoms') else [g]
    return ''.join('M' + 'L'.join(f'{x:.1f},{y:.1f}' for x, y in p.simplify(0.25).exterior.coords[:-1]) + 'Z' for p in polys if p.area > 1)
data = {v: {'sil': d(sil), **{m: d(g) for m, g in parts.items()}} for v, parts in (('front', front), ('back', back))}
json.dump(data, open('body.json', 'w'))
print('bytes', len(json.dumps(data)), 'bounds', [round(b) for b in sil.bounds])
