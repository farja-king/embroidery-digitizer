"""Turns a stitched alphabet chart (a DST) into a reusable embroidery font.

Every satin column in the file is a list of points alternating between the two
edges of a stroke, so the columns can be read straight back out: their exact
rails, in the exact order the machine sews them. That is what a digitized
embroidery font is, and it is why letters built from this look like the original
rather than like an approximation of it.
"""
import sys, math, json
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
    a, b = col[0::2], col[1::2]
    walk = lambda r: sum(D(r[i - 1], r[i]) for i in range(1, len(r)))
    la, lb = walk(a), walk(b)
    if max(la, lb) > 1e-6 and min(la, lb) < max(la, lb) * 0.3:
        return False
    return True


def split_rails(col):
    """Separates a column's stitches into its two rails.

    Taking every other point would be the obvious way, and is what the stitches
    nominally alternate as -- but a single extra stitch anywhere in the column
    (a tie, a tuck, a lock at a corner) shifts the parity, and from there on the
    two rails swap over. Drawn as a band that shows up as a bow-tie across the
    stroke, which is what put starbursts inside the "e", "o" and "s".

    Which side of the column a stitch is on does not depend on parity, so that
    is what decides it: build a rough centreline from consecutive midpoints,
    then put each point on a rail according to the side of the local direction
    of travel it falls on."""
    n = len(col)
    mids = [((col[i][0] + col[i + 1][0]) / 2, (col[i][1] + col[i + 1][1]) / 2) for i in range(n - 1)]
    # Smooth the centreline: raw midpoints jitter by half the density.
    sm = []
    for i in range(len(mids)):
        lo = max(0, i - 2)
        hi = min(len(mids), i + 3)
        w = mids[lo:hi]
        sm.append((sum(q[0] for q in w) / len(w), sum(q[1] for q in w) / len(w)))
    a, b = [], []
    for i, p in enumerate(col):
        j = min(max(i - 1, 0), len(sm) - 1)
        j2 = min(j + 1, len(sm) - 1)
        tx, ty = sm[j2][0] - sm[j][0], sm[j2][1] - sm[j][1]
        if abs(tx) < 1e-9 and abs(ty) < 1e-9:
            k = max(0, j - 1)
            tx, ty = sm[j][0] - sm[k][0], sm[j][1] - sm[k][1]
        cross = tx * (p[1] - sm[j][1]) - ty * (p[0] - sm[j][0])
        (a if cross >= 0 else b).append(p)
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
            a = rdp(a, 0.05)
            b = rdp(b, 0.05)
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

    font = {
        "name": name,
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
    print(f"wrote {out_path}")


main(sys.argv[1], sys.argv[2], sys.argv[3])
