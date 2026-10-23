# Original anatomical body figure for the Stats body maps, drawn from anatomy, not traced.
# Right half authored (x >= 0), mirrored. Units match BODY in public/app.js: origin top centre,
# about 150 x 460, an athletic figure about 7.5 heads tall (chin 62, nipples ~114, navel ~172, crotch ~246,
# knees ~328, feet 460). Each muscle is a smooth closed curve through anatomical landmarks.
# Needs shapely. Run: python3 tools/body_figure.py [out.json]
#   -> paste the front/back strings into BODY in app.js.
import json, sys
from shapely.geometry import Polygon, LineString
from shapely.ops import unary_union
from shapely import affinity


def catmull(pts, n=10):
    """closed Catmull-Rom curve through pts"""
    out, P = [], pts + pts[:3]
    for i in range(len(pts)):
        p0, p1, p2, p3 = P[i], P[i + 1], P[i + 2], P[i + 3]
        for k in range(n):
            t = k / n; t2, t3 = t * t, t * t * t
            out.append(tuple(0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2
                                    + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3) for j in range(2)))
    return out


def S(*pts): return Polygon(catmull(list(pts))).buffer(0)
def mirror(g): return affinity.scale(g, -1, 1, origin=(0, 0))
def both(g): return unary_union([g, mirror(g)])
def strap(*pts, w=2.4): return LineString(catmull(list(pts) + list(reversed(pts[1:-1])), 6)).buffer(w / 2)
RIGHT = Polygon([(0, -10), (200, -10), (200, 500), (0, 500)])

# ---------- silhouette (right half) ----------
head = S((0, 0), (12, 2), (20, 11), (22, 26), (20, 41), (15, 53), (7, 61), (0, 62), (-7, 61), (-15, 53), (-20, 41),
         (-22, 26), (-20, 11), (-12, 2))
trunk = S((0, 56), (15, 57), (16, 66), (24, 76), (38, 83), (52, 88), (60, 98), (57, 116), (49, 124),
          (47, 140), (44, 162), (41, 180), (41, 196), (45, 214), (50, 232), (53, 252), (53, 278), (50, 304),
          (45, 324), (43, 340), (47, 358), (45, 384), (38, 408), (33, 426), (37, 440), (41, 452), (34, 459),
          (19, 459), (16, 446), (18, 430), (20, 424), (16, 400), (13, 376), (14, 354), (15, 338), (12, 322),
          (9, 298), (6, 272), (3, 252), (0, 247), (-1, 150))
arm = S((46, 90), (60, 89), (70, 98), (74, 112), (72, 130), (70, 144), (70, 156), (69, 170), (73, 184), (75, 202),
        (72, 222), (69, 233), (61, 235), (58, 222), (56, 205), (54, 188), (54, 172), (52, 154), (50, 134),
        (48, 118), (47, 104))
hand = S((61, 231), (69, 231), (74, 242), (75, 258), (72, 270), (66, 275), (61, 268), (59, 254), (59, 240))
right = unary_union([trunk, arm, hand]).intersection(RIGHT)
sil = unary_union([head, both(right)]).buffer(1.5).buffer(-1.5)
inner = sil.buffer(-2.2)            # rim of silhouette colour around the muscles

GAP = 1.4
def finish(parts):
    """parts: [(muscle or None, right-side shape)] in priority order -> {muscle: both sides}.
    Earlier shapes win where they overlap; None shapes only carve a gap (tendons, sartorius...)."""
    used, out = None, {}
    for m, g in parts:
        g = g.intersection(inner).intersection(RIGHT)
        if used is not None: g = g.difference(used.buffer(GAP))
        if g.is_empty: continue
        used = g if used is None else unary_union([used, g])
        if m is None: continue
        g = g.buffer(-1.2).buffer(1.2)                 # soften corners left by the cuts
        out.setdefault(m, []).append(both(g))
    return {m: unary_union(gs) for m, gs in out.items()}

# deltoid: a rounded cap from the collarbone/shoulder blade that narrows to a point halfway down the arm
DELT = S((42, 89), (52, 86), (62, 89), (70, 98), (74, 111), (72, 125), (68, 137), (64, 147), (61, 140),
         (58, 126), (54, 112), (46, 100))
FRONT_HALF = Polygon([(30, 70), (56, 80), (59, 98), (62, 120), (61, 150), (30, 150)])

# rectus abdominis: two columns, three tendinous bands above the navel, a long tapering lower part
def ab(y0, y1, w0, w1, sag=1.2):
    return S((1.8, y0 + 0.6), (w0 * 0.55, y0), (w0, y0 + sag), (w0 + 0.6, (y0 + y1) / 2), (w1, y1 - sag),
             (w1 * 0.55, y1), (1.8, y1 - 0.6))

front = finish([
    ('neck', S((5, 63), (12, 61), (15, 65), (10, 74), (5, 82), (3, 80), (4, 72))),               # sternocleidomastoid
    ('traps', S((15, 64), (18, 70), (27, 78), (40, 84), (47, 88), (34, 88), (24, 86), (17, 79))),
    ('frontDelt', DELT.intersection(FRONT_HALF)),
    ('sideDelt', DELT.difference(FRONT_HALF)),
    ('chest', S((2, 92), (14, 89), (30, 89), (42, 92), (50, 100), (52, 108), (47, 114), (40, 121), (31, 127),
                (20, 130), (9, 130), (2, 126))),
    ('lats', S((45, 122), (49, 121), (48, 136), (45, 154), (42, 146), (43, 132))),                 # seen under the armpit
    ('obliques', S((37, 125), (44, 123), (45, 129), (39, 131))),                                   # serratus slips
    ('obliques', S((36, 133), (44, 131), (44, 137), (37, 139))),
    ('obliques', S((36, 141), (43, 140), (43, 146), (37, 147))),
    ('abs', ab(131, 148, 15.5, 16.5)), ('abs', ab(150, 166, 16.3, 15.6)), ('abs', ab(168, 184, 15.4, 14.2)),
    ('abs', S((1.8, 186.6), (8, 186), (14.2, 187.4), (13.6, 206), (11.4, 226), (7.6, 242), (3.4, 249), (1.8, 247))),
    ('obliques', S((20, 136), (31, 136), (38, 150), (38, 170), (38, 190), (42, 208), (42, 220), (32, 231),
                   (17, 245), (14, 234), (16, 206), (18, 180), (19, 156))),
    (None, strap((44, 229), (34, 244), (24, 264), (16, 290), (12, 322), w=2.6)),                  # sartorius
    ('adductors', S((4, 252), (12, 247), (24, 244), (28, 247), (21, 262), (15, 280), (11, 290), (8, 279),
                    (6, 265))),
    ('quads', S((47, 232), (52, 248), (53, 270), (51, 294), (47, 314), (42, 327), (37, 329), (37, 312),
                (40, 290), (43, 268), (43, 248))),                                                # vastus lateralis
    ('quads', S((38, 240), (41, 258), (40, 282), (37, 302), (32, 318), (28, 323), (23, 314), (23, 296),
                (25, 276), (30, 254))),                                                           # rectus femoris
    ('quads', S((19, 284), (24, 286), (29, 300), (31, 315), (28, 327), (21, 331), (15, 326), (15, 308),
                (16, 294))),                                                                      # vastus medialis
    ('calves', S((26, 340), (35, 342), (39, 352), (38, 370), (34, 392), (31, 410), (29, 414), (28, 398),
                 (26, 376), (24, 354))),                                                          # tibialis anterior
    ('calves', S((41, 344), (46, 350), (48, 364), (45, 382), (41, 396), (40, 378), (40, 358))),    # outer calf
    ('calves', S((13, 338), (19, 338), (22, 350), (22, 368), (19, 386), (15, 396), (12, 384), (11, 360))),  # inner calf
    ('forearms', S((65, 170), (71, 178), (74, 192), (73, 208), (69, 223), (66, 223), (66, 204), (65, 186),
                   (64, 176))),                                                                   # brachioradialis
    ('forearms', S((55, 176), (61, 175), (64, 186), (64, 204), (64, 224), (61, 227), (58, 214), (56, 197),
                   (54, 184))),                                                                   # flexors
    ('biceps', S((54, 112), (60, 117), (66, 134), (67, 154), (64, 166), (60, 171), (56, 165), (53, 148),
                 (52, 128))),
])

back = finish([
    ('traps', S((2, 54), (10, 56), (15, 64), (22, 75), (34, 81), (51, 88), (46, 94), (32, 98), (24, 110),
                (17, 132), (9, 156), (2, 170))),
    ('rearDelt', DELT.intersection(FRONT_HALF)),
    ('sideDelt', DELT.difference(FRONT_HALF)),
    ('upperBack', S((25, 102), (38, 98), (49, 101), (52, 110), (47, 120), (37, 123), (28, 117))),   # infraspinatus
    ('upperBack', S((37, 125), (47, 123), (52, 127), (47, 133), (38, 131))),                        # teres major
    ('lowerBack', S((2, 172), (8, 170), (12, 182), (14, 200), (14, 218), (12, 232), (6, 237), (2, 235))),  # erector spinae
    ('lats', S((14, 150), (22, 137), (36, 133), (48, 131), (52, 135), (48, 148), (46, 168), (43, 188),
               (39, 205), (28, 213), (20, 203), (15, 186), (13, 166))),
    ('obliques', S((39, 210), (44, 203), (46, 216), (46, 226), (39, 225), (33, 218))),
    ('glutes', S((25, 218), (39, 212), (47, 222), (49, 236), (41, 238), (31, 230))),                # gluteus medius
    ('glutes', S((3, 233), (16, 227), (31, 231), (43, 240), (49, 254), (47, 270), (38, 279), (22, 281),
                 (6, 277), (2, 256))),                                                           # gluteus maximus
    ('adductors', S((4, 280), (10, 281), (11, 298), (12, 316), (8, 308), (5, 294))),                # adductor magnus
    ('hamstrings', S((30, 284), (42, 281), (49, 292), (47, 314), (41, 332), (35, 339), (31, 324), (29, 302))),  # biceps femoris
    ('hamstrings', S((13, 283), (25, 284), (28, 298), (28, 320), (24, 336), (18, 338), (14, 324), (12, 300))),  # semitendinosus/-membranosus
    ('calves', S((16, 341), (27, 339), (29, 353), (28, 372), (24, 390), (19, 393), (15, 379), (14, 358))),  # gastrocnemius, inner head
    ('calves', S((31, 339), (42, 341), (46, 355), (44, 371), (39, 383), (33, 381), (31, 361))),     # gastrocnemius, outer head
    ('calves', S((18, 396), (27, 390), (37, 386), (42, 384), (40, 398), (34, 411), (27, 414), (20, 408))),  # soleus
    ('triceps', S((50, 110), (57, 112), (60, 132), (59, 156), (57, 166), (53, 166), (51, 148), (49, 128))),  # long head
    ('triceps', S((61, 120), (67, 126), (70, 138), (69, 152), (65, 162), (61, 158), (60, 138))),    # lateral head
    ('forearms', S((64, 172), (70, 178), (73, 192), (72, 208), (69, 223), (66, 223), (66, 204), (64, 186))),
    ('forearms', S((55, 176), (61, 174), (63, 186), (63, 204), (63, 224), (60, 227), (57, 214), (55, 197),
                   (54, 184))),
])


def d(g):
    polys = list(g.geoms) if hasattr(g, 'geoms') else [g]
    return ''.join('M' + 'L'.join(f'{x:.1f},{y:.1f}' for x, y in p.simplify(0.2).exterior.coords[:-1]) + 'Z'
                   for p in polys if p.area > 1)


data = {v: {'sil': d(sil), **{m: d(g) for m, g in parts.items()}} for v, parts in (('front', front), ('back', back))}
out = sys.argv[1] if len(sys.argv) > 1 else 'body.json'
json.dump(data, open(out, 'w'))
print('bytes', len(json.dumps(data)), 'bounds', [round(b) for b in sil.bounds])
