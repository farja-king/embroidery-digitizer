"""Turns a stitched alphabet chart (a DST) into a reusable embroidery font.

Every satin column in the file is a list of points alternating between the two
edges of a stroke, so the columns can be read straight back out: their exact
rails, in the exact order the machine sews them. That is what a digitized
embroidery font is, and it is why letters built from this look like the original
rather than like an approximation of it.
"""
import sys, math, json, hashlib
import pyembroidery as pe

STITCH, JUMP, TRIM, STOP, END, CC = 0, 1, 2, 3, 4, 5
D = lambda a, b: math.hypot(b[0] - a[0], b[1] - a[1])

# Read in the order the glyphs appear on the chart. Fragments that belong to one
# character are listed together; see the contact sheet this was read from.
LABELS = [
    "A", "a", "B", "b", "C", "c", "D", "d", "E", "e", "F", "f", "G",
    "g", "H", "h", "I", "i", ("J", 2), ("j", 2), "K", "k", "L", "l",
    "M", "m", "N", "n", "O", "o", "P", "p", "Q", "q", "R", "r", "S",
    "s", "T", "t", "U", "u", "V", "v", "W", "w", "X", "x", "Y", "y",
    "Z", "z", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "!",
    '"', "£", "$", "%", "&", "*", "(", ")", "-", "+", (":", 2), "@",
]


def satin_at(p, i):
    if i + 2 >= len(p):
        return False
    same = D(p[i], p[i + 2])
    across = D(p[i], p[i + 1])
    return same < 1.6 and across > max(0.55, same * 1.4) and across < 6.0


def columns(p):
    flags = [satin_at(p, i) for i in range(len(p))]
    out, s = [], None
    for i, z in enumerate(flags):
        if z and s is None:
            s = i
        elif not z and s is not None:
            e = min(len(p), i + 2)
            if e - s >= 6:
                out.append(p[s:e])
            s = None
    if s is not None and len(p) - s >= 6:
        out.append(p[s:])
    return out


def plausible_column(col):
    """Rejects a stretch that only looked like a column.

    Travel inside a letter can happen to alternate back and forth for a few
    stitches and pass the local test, and what comes out is a fan of stitches
    radiating from one spot -- which is exactly the starburst that appeared in
    the middle of "o", "e" and "s". A real satin column has a width that stays
    roughly constant along it; a fan's does not, and neither rail behaves like a
    line."""
    rungs = [D(col[i], col[i + 1]) for i in range(len(col) - 1)]
    if len(rungs) < 5:
        return False
    rs = sorted(rungs)
    med = rs[len(rs) // 2]
    if med < 0.5 or med > 5.0:
        return False
    # A fan swings from nearly nothing to the full radius; a column does not.
    if rs[-1] > med * 3.0 or rs[0] < med * 0.18:
        return False
    # A fan pivots about one point, so one of its "rails" barely travels while
    # the other sweeps. Measured as distance walked along each rail, not end to
    # end: a column that closes on itself, like the ring of an "o", starts and
    # finishes in the same place and would look stationary end to end.
    a, b = split_rails(col)
    if len(a) < 2 or len(b) < 2:
        return False
    walk = lambda r: sum(D(r[i - 1], r[i]) for i in range(1, len(r)))
    la, lb = walk(a), walk(b)
    if max(la, lb) > 1e-6 and min(la, lb) < max(la, lb) * 0.3:
        return False
    return True


def split_rails(col):
    """The column's two rails, as matched pairs.

    Consecutive stitches in a satin are the rungs: the needle crosses the
    stroke, crosses back a fraction further on, and so on. So the pairing is
    already in the file and does not have to be inferred -- col[0] with col[1],
    col[2] with col[3], and so on. Measured on the chart, 257 of 258 consecutive
    distances in its largest column fall between 1.3mm and 1.6mm, which is that
    column's width.

    The one exception is what makes this worth writing out. An occasional extra
    stitch -- a tie, a lock at a corner -- lands on the rail it is already on,
    and from there the parity is inverted and the two rails swap over for the
    rest of the column. That shows up as a bow-tie across the stroke, and is
    what put starbursts inside the "e", "o" and "s". A step like that is short,
    a fraction of a rung, so it can be spotted and stepped over.

    Keeping the rungs paired is the point of the exercise. Given only two loose
    rails, anything downstream has to guess which point faces which by walking a
    fraction along each, and on a curve the outer rail runs ahead of the inner
    one: the "e" came out with its width swinging between 0.03mm and 0.17mm and
    the "t" with its two rails touching."""
    ds = [D(col[i], col[i + 1]) for i in range(len(col) - 1)]
    if not ds:
        return [], []
    med = sorted(ds)[len(ds) // 2]
    a, b = [], []
    i = 0
    while i + 1 < len(col):
        if ds[i] < med * 0.55:
            i += 1  # a step along a rail, not a rung: skip it and resync
            continue
        p, q = col[i], col[i + 1]
        # Orientation carries over from the rung before, so a rail stays a rail
        # all the way along instead of flipping side at every stitch.
        if a and D(a[-1], q) + D(b[-1], p) < D(a[-1], p) + D(b[-1], q):
            p, q = q, p
        a.append(p)
        b.append(q)
        i += 2
    return a, b


def bbox(pts):
    xs = [q[0] for q in pts]
    ys = [q[1] for q in pts]
    return min(xs), max(xs), min(ys), max(ys)


def rdp(pts, eps):
    """Ramer-Douglas-Peucker: drops points that do not change the line's shape,
    which cuts the stored size a long way without rounding off corners."""
    if len(pts) < 3:
        return list(pts)
    a, b = pts[0], pts[-1]
    dx, dy = b[0] - a[0], b[1] - a[1]
    L = math.hypot(dx, dy)
    worst, wi = -1.0, 0
    for i in range(1, len(pts) - 1):
        p = pts[i]
        d = abs(dx * (a[1] - p[1]) - (a[0] - p[0]) * dy) / L if L > 1e-9 else D(p, a)
        if d > worst:
            worst, wi = d, i
    if worst <= eps:
        return [a, b]
    return rdp(pts[: wi + 1], eps)[:-1] + rdp(pts[wi:], eps)


def unshorten(a, b, rounds=3):
    """Puts back the edge that the chart's own short stitches pulled in.

    On the inside of a tight turn a digitizer does not send every penetration
    to the inner edge -- holes that close together tear the fabric -- so some
    are pulled back into the body of the stroke. Read straight out of the file
    those shortened stitches look like an edge that wobbles in and out by half
    a millimetre. The "t" of "Test" had four in a row, and the tail drawn from
    them came out as a fan from a pivot with a notch missing.

    A point that sits inside the line between its own two neighbours is put
    back on that line. It only ever moves outward to the edge, never past it,
    and on a smoothly curving edge the correction is a hundredth of a
    millimetre, so a real curve is left alone. What this buys is a clean
    separation: the font holds the shape of the stroke, and whether a stitch
    needs shortening is decided when it is sewn, from the density in force at
    that size, rather than inherited from a chart stitched at another one."""
    a = [list(p) for p in a]
    b = [list(p) for p in b]
    for _ in range(rounds):
        for r, other in ((a, b), (b, a)):
            for i in range(1, len(r) - 1):
                p0, p1, p2 = r[i - 1], r[i], r[i + 1]
                dx, dy = p2[0] - p0[0], p2[1] - p0[1]
                L2 = dx * dx + dy * dy
                if L2 < 1e-12:
                    continue
                t = ((p1[0] - p0[0]) * dx + (p1[1] - p0[1]) * dy) / L2
                t = min(1.0, max(0.0, t))
                qx, qy = p0[0] + dx * t, p0[1] + dy * t
                # Only if the point is displaced towards the far edge, which is
                # the direction a shortened stitch pulls it.
                if (p1[0] - qx) * (other[i][0] - qx) + (p1[1] - qy) * (other[i][1] - qy) > 0:
                    r[i][0], r[i][1] = qx, qy
    return [tuple(p) for p in a], [tuple(p) for p in b]


def joint_rdp(a, b, eps):
    """Ramer-Douglas-Peucker over both rails at once.

    Simplifying each rail on its own drops a different set of points from each
    and the pairing is gone, which is the whole thing worth keeping. Here an
    index survives on both rails if either rail needs it."""
    n = len(a)
    if n < 3:
        return list(a), list(b)
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        lo, hi = stack.pop()
        if hi - lo < 2:
            continue
        worst, wi = -1.0, -1
        for r in (a, b):
            p0, p1 = r[lo], r[hi]
            dx, dy = p1[0] - p0[0], p1[1] - p0[1]
            L = math.hypot(dx, dy)
            for i in range(lo + 1, hi):
                p = r[i]
                d = abs(dx * (p0[1] - p[1]) - (p0[0] - p[0]) * dy) / L if L > 1e-9 else D(p, p0)
                if d > worst:
                    worst, wi = d, i
        if worst > eps and wi > lo:
            keep[wi] = True
            stack.append((lo, wi))
            stack.append((wi, hi))
    idx = [i for i in range(n) if keep[i]]
    return [a[i] for i in idx], [b[i] for i in idx]


def main(path, out_path, name):
    st = pe.read(path).stitches
    runs, cur = [], []
    for x, y, c in st:
        if c == STITCH:
            cur.append((x / 10.0, y / 10.0))
        elif c in (TRIM, CC, STOP, END):
            if cur:
                runs.append(cur)
                cur = []
    if cur:
        runs.append(cur)

    info = []
    for r in runs:
        cs = columns(r)
        if not cs:
            continue
        x0, x1, y0, y1 = bbox(r)
        info.append(dict(cols=cs, cx=(x0 + x1) / 2, cy=(y0 + y1) / 2))

    rows = []
    for v in sorted(info, key=lambda v: v["cy"]):
        if rows and v["cy"] - rows[-1][-1]["cy"] < 8:
            rows[-1].append(v)
        else:
            rows.append([v])

    # One entry per glyph-shaped cluster, in reading order, each still carrying
    # the stitch order its columns were sewn in.
    pieces = []
    for ri, row in enumerate(rows):
        row.sort(key=lambda v: v["cx"])
        for v in row:
            cs = sorted(v["cols"], key=lambda c: bbox(c)[0])
            if ri < 4 and len(cs) > 1:
                reach = bbox(cs[0])[1]
                best = (-1.0, 1)
                for k in range(1, len(cs)):
                    g = bbox(cs[k])[0] - reach
                    if g > best[0]:
                        best = (g, k)
                    reach = max(reach, bbox(cs[k])[1])
                k = max(1, best[1])
                parts = [cs[:k], cs[k:]]
            else:
                parts = [cs]
            for p in parts:
                if p:
                    pieces.append((ri, p))

    # Merge the fragments that belong to one character.
    merged = []
    pi = 0
    for lab in LABELS:
        ch, n = (lab, 1) if isinstance(lab, str) else lab
        if pi >= len(pieces):
            print(f"ran out of pieces at '{ch}'")
            break
        group = []
        row_of = pieces[pi][0]
        for _ in range(n):
            if pi >= len(pieces):
                break
            group.extend(pieces[pi][1])
            pi += 1
        merged.append((ch, row_of, group))
    print(f"pieces found {len(pieces)}, labels expect {sum(1 if isinstance(l, str) else l[1] for l in LABELS)}")
    if pi != len(pieces):
        print(f"WARNING: {len(pieces)} pieces, labels consumed {pi}")

    # Baseline per row: most glyphs in a row sit on it, so the median of their
    # lowest edge is it. Descenders pull their own glyph past it and are ignored
    # by the median.
    baselines = {}
    for ri in set(r for _, r, _ in merged):
        bots = [bbox([q for c in g for q in c])[3] for ch, r, g in merged if r == ri]
        bots.sort()
        baselines[ri] = bots[len(bots) // 2]

    # Cap height from the plain capitals, which have no overshoot.
    caps = []
    for ch, ri, g in merged:
        if ch in "EFHILT":
            x0, x1, y0, y1 = bbox([q for c in g for q in c])
            caps.append(baselines[ri] - y0)
    cap_mm = sorted(caps)[len(caps) // 2]

    # Side bearing from the gap Hatch left between the two letters of a pair.
    gaps = []
    for i in range(len(merged) - 1):
        (c1, r1, g1), (c2, r2, g2) = merged[i], merged[i + 1]
        if r1 != r2 or not c1.isalpha() or not c2.isalpha():
            continue
        if c1.upper() != c2.upper():
            continue
        gaps.append(bbox([q for c in g2 for q in c])[0] - bbox([q for c in g1 for q in c])[1])
    gaps.sort()
    gap_mm = gaps[len(gaps) // 2]

    # Normalise to an em square, so a size set in this font matches the same
    # size set in an ordinary font. 0.716 is the cap-height-to-em ratio of the
    # typeface this chart was set in.
    CAP_PER_EM = 0.716
    em_mm = cap_mm / CAP_PER_EM
    S = 1.0 / em_mm

    glyphs = {}
    drops = []
    total_pts = 0
    for ch, ri, cols in merged:
        x0, x1, y0, y1 = bbox([q for c in cols for q in c])
        base = baselines[ri]
        out_cols = []
        dropped = 0
        for c in cols:
            # Filtered here rather than at detection: dropping a column earlier
            # can empty a glyph entirely, which shifts every label after it and
            # silently mislabels the rest of the alphabet.
            if not plausible_column(c):
                dropped += 1
                continue
            a, b = split_rails(c)
            if len(a) < 2 or len(b) < 2:
                continue
            a, b = unshorten(a, b)
            a, b = joint_rdp(a, b, 0.05)
            total_pts += len(a) + len(b)
            conv = lambda pts: [[round((q[0] - x0) * S, 5), round((q[1] - base) * S, 5)] for q in pts]
            out_cols.append({"a": conv(a), "b": conv(b)})
        if dropped:
            drops.append(f"{ch}:{dropped}")
        if not out_cols:
            continue
        glyphs[ch] = {
            "adv": round((x1 - x0 + gap_mm) * S, 5),
            "cols": out_cols,
        }

    # A short fingerprint of the geometry. A saved design stores the stamp of
    # the font its letters were built from, so when the font is rebuilt the app
    # can tell that the geometry it has is stale and set the words again from
    # the wording it kept. Without that a design saved today would keep sewing
    # yesterday's rails for ever.
    stamp = hashlib.sha1(json.dumps(glyphs, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:12]

    font = {
        "name": name,
        "version": stamp,
        "source": "decoded from a stitched alphabet chart",
        "capHeight": round(cap_mm * S, 5),
        "spaceAdvance": round(0.28, 5),
        "glyphs": glyphs,
    }
    json.dump(font, open(out_path, "w"), separators=(",", ":"))
    print(f"{len(glyphs)} glyphs, {total_pts} rail points")
    if drops:
        print("columns rejected as not real satin:", " ".join(drops))
    print(f"cap height {cap_mm:.2f}mm, letter gap {gap_mm:.2f}mm, em {em_mm:.2f}mm")
    print(f"wrote {out_path} (version {stamp})")


main(sys.argv[1], sys.argv[2], sys.argv[3])
