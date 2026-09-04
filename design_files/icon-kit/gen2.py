import math

# ─────────────────────────  path helpers  ─────────────────────────
def sub(a, b): return (a[0] - b[0], a[1] - b[1])
def add(a, b): return (a[0] + b[0], a[1] + b[1])
def mul(a, k): return (a[0] * k, a[1] * k)
def norm(a):
    m = math.hypot(*a) or 1.0
    return (a[0] / m, a[1] / m)

def bez(p0, p1, p2, p3, t):
    u = 1 - t
    return (u**3*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t**3*p3[0],
            u**3*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t**3*p3[1])

def split(p0, p1, p2, p3, t):
    a = add(p0, mul(sub(p1, p0), t)); b = add(p1, mul(sub(p2, p1), t))
    c = add(p2, mul(sub(p3, p2), t))
    d = add(a, mul(sub(b, a), t)); e = add(b, mul(sub(c, b), t))
    f = add(d, mul(sub(e, d), t))
    return (p0, a, d, f), (f, e, c, p3)

def arclen(p0, p1, p2, p3, t0, t1, n=60):
    L, prev = 0.0, bez(p0, p1, p2, p3, t0)
    for i in range(1, n + 1):
        cur = bez(p0, p1, p2, p3, t0 + (t1 - t0) * i / n)
        L += math.dist(prev, cur); prev = cur
    return L

def t_for_len_from_end(p0, p1, p2, p3, d):
    lo, hi = 0.0, 1.0
    for _ in range(40):
        mid = (lo + hi) / 2
        if arclen(p0, p1, p2, p3, mid, 1.0) > d: lo = mid
        else: hi = mid
    return (lo + hi) / 2

def t_for_len_from_start(p0, p1, p2, p3, d):
    lo, hi = 0.0, 1.0
    for _ in range(40):
        mid = (lo + hi) / 2
        if arclen(p0, p1, p2, p3, 0.0, mid) < d: lo = mid
        else: hi = mid
    return (lo + hi) / 2


class Shape:
    """Closed outline of line + cubic segments, with automatic corner fillets."""
    def __init__(self, start):
        self.start = start
        self.segs = []          # ('L', end) | ('C', c1, c2, end)
        self.r = {}             # vertex index -> fillet cut distance

    def L(self, p, r=None):
        self.segs.append(['L', p])
        if r: self.r[len(self.segs) - 1] = r
        return self

    def C(self, c1, c2, p, r=None):
        self.segs.append(['C', c1, c2, p])
        if r: self.r[len(self.segs) - 1] = r
        return self

    def close(self, r=None):
        self.segs.append(['L', self.start])
        if r: self.r[len(self.segs) - 1] = r
        return self

    def _pts(self):
        pts, cur = [], self.start
        for s in self.segs:
            pts.append((cur, s)); cur = s[-1]
        return pts

    def d(self, default_r=3.5, min_turn=7.0):
        segs = [list(s) for s in self.segs]
        starts = [self.start] + [s[-1] for s in segs[:-1]]
        n = len(segs)
        fillets = {}
        for i in range(n):
            j = (i + 1) % n
            V = segs[i][-1]
            # tangent arriving at V
            u_in = norm(sub(V, segs[i][1] if segs[i][0] == 'C' else starts[i]))
            nxt_ctrl = segs[j][1] if segs[j][0] == 'C' else segs[j][-1]
            u_out = norm(sub(nxt_ctrl, V))
            ang = math.degrees(math.acos(max(-1, min(1, u_in[0]*u_out[0] + u_in[1]*u_out[1]))))
            if ang < min_turn:
                continue
            rr = self.r.get(i, default_r)
            fillets[i] = (add(V, mul(u_in, -rr)), V, add(V, mul(u_out, rr)), rr)

        # trim segments
        out = []
        for i in range(n):
            s = segs[i]
            prev = (i - 1) % n
            p0 = starts[i]
            if s[0] == 'L':
                a = fillets[prev][2] if prev in fillets else p0
                b = fillets[i][0] if i in fillets else s[-1]
                out.append(('L', a, b))
            else:
                p1, p2, p3 = s[1], s[2], s[3]
                cur = (p0, p1, p2, p3)
                if prev in fillets:
                    t = t_for_len_from_start(*cur, fillets[prev][3])
                    cur = split(*cur, t)[1]
                if i in fillets:
                    t = t_for_len_from_end(*cur, fillets[i][3])
                    cur = split(*cur, t)[0]
                out.append(('C', cur[0], cur[1], cur[2], cur[3]))

        def f(v):
            s = f"{v:.2f}".rstrip('0').rstrip('.')
            return s if s != '-0' else '0'
        def P(p): return f"{f(p[0])} {f(p[1])}"

        d = [f"M{P(out[0][1])}"]
        for i, seg in enumerate(out):
            if seg[0] == 'L': d.append(f"L{P(seg[2])}")
            else: d.append(f"C{P(seg[2])} {P(seg[3])} {P(seg[4])}")
            if i in fillets:
                _, V, after, _ = fillets[i]
                d.append(f"Q{P(V)} {P(after)}")
        d.append("Z")
        return "".join(d)


# ─────────────────────────  squircle  ─────────────────────────
def squircle(cx, cy, half, R, n=2.2, segs=3):
    def pt(t):
        return (R - R * math.cos(t) ** (2.0 / n), R - R * math.sin(t) ** (2.0 / n))
    def tan(t, h=1e-5):
        a = pt(max(t - h, 1e-9)); b = pt(min(t + h, math.pi / 2 - 1e-9))
        return norm(sub(b, a))
    x0, y0 = cx - half, cy - half
    pts = [(x0 + pt(math.pi/2*i/segs)[0], y0 + pt(math.pi/2*i/segs)[1]) for i in range(segs+1)]
    tans = [tan(math.pi/2*i/segs) for i in range(segs+1)]
    corner = []
    for i in range(segs):
        p0, p3, t0, t3 = pts[i], pts[i+1], tans[i], tans[i+1]
        dist = math.dist(p0, p3); best, err = None, 1e9
        for k in [x/400 for x in range(10, 240)]:
            a = k*dist
            p1 = add(p0, mul(t0, a)); p2 = sub(p3, mul(t3, a))
            e = 0
            for s in (0.25, 0.5, 0.75):
                b = bez(p0, p1, p2, p3, s)
                g = pt(math.pi/2*(i+s)/segs)
                e += (b[0]-(x0+g[0]))**2 + (b[1]-(y0+g[1]))**2
            if e < err: err, best = e, (p1, p2)
        corner.append((p0, best[0], best[1], p3))
    def f(v): return f"{v:.2f}".rstrip('0').rstrip('.')
    out = []
    for q in range(4):
        for (p0, p1, p2, p3) in corner:
            def rot(p):
                x, y = p[0]-cx, p[1]-cy
                for _ in range(q): x, y = -y, x
                return (cx+x, cy+y)
            a, b, c, dd = rot(p0), rot(p1), rot(p2), rot(p3)
            if not out: out.append(f"M{f(a[0])} {f(a[1])}")
            out.append(f"C{f(b[0])} {f(b[1])} {f(c[0])} {f(c[1])} {f(dd[0])} {f(dd[1])}")
    out.append("Z")
    return "".join(out)


# ─────────────────────────  shared letter metrics  ─────────────────────────
CX = 256
BAR_TOP, BAR_UNDER, SERIF_BOT = 124, 164, 185.5
ARM_L, ARM_R = 134.5, 377.5
SERIF_IN_L, SERIF_IN_R = 144.0, 368.0
BRK_L, BRK_R = 170.9, 341.1
STEM_L, STEM_R = 230.0, 282.0
FLARE_TOP, SLAB_TOP, FOOT_BOT = 349, 377, 387
FOOT_L, FOOT_R = 206.5, 305.5

def foot_and_stem(apex_y, wedge_base, slope, apex_r=6.0):
    """stem + foot, wedge rising to a point at (CX, apex_y)"""
    s = Shape((CX, apex_y))
    s.L((STEM_R, wedge_base), r=4)
    s.L((STEM_R, FLARE_TOP))
    s.C((STEM_R, 366), (290, SLAB_TOP), (FOOT_R, SLAB_TOP), r=3)
    s.L((FOOT_R, FOOT_BOT), r=3)
    s.L((FOOT_L, FOOT_BOT), r=3)
    s.L((FOOT_L, SLAB_TOP), r=3)
    s.C((222, SLAB_TOP), (STEM_L, 366), (STEM_L, FLARE_TOP))
    s.L((STEM_L, wedge_base), r=4)
    s.close(r=apex_r)                  # closing vertex = the apex
    return s

def arm(outer, inner_top, inner_bot, brk, serif_in, mirror=False, valley=None):
    """One crossbar arm. valley=(x,y) turns the inner end into a pointed V."""
    sgn = -1 if mirror else 1
    s = Shape((outer, BAR_TOP))
    s.L((inner_top, BAR_TOP), r=3.5)
    if valley:
        s.L(valley, r=5)
        s.L((inner_bot, BAR_UNDER), r=5)
    else:
        s.L((inner_bot, BAR_UNDER), r=4.5)
    s.L((brk, BAR_UNDER), r=3)
    c1 = (brk - sgn*7.9, BAR_UNDER + 0.6)
    c2 = (serif_in + sgn*6, 177)
    s.C(c1, c2, (serif_in, SERIF_BOT), r=3)
    s.L((outer, SERIF_BOT), r=3)
    s.close(r=3.5)
    return s


# ─────────────────────────  variant A — the T  ─────────────────────────
SL = 0.765
A_left  = arm(ARM_L, 248.5, 217.9, BRK_L, SERIF_IN_L)
A_right = arm(ARM_R, 263.5, 294.1, BRK_R, SERIF_IN_R, mirror=True)
A_stem  = foot_and_stem(137.2, 172, SL, apex_r=5.0)

# ─────────────────────────  variant B — T reading as W  ─────────────────────────
SW      = 0.55                       # steeper cuts
W_APEX  = BAR_TOP                    # middle peak reaches the cap line
W_BASE  = W_APEX + 26 / SW           # 171.3
GAP     = 14                         # horizontal channel width
VAL_Y   = SERIF_BOT                  # valleys align with the serif baseline
VAL_X   = CX - GAP - SW * (VAL_Y - BAR_TOP)
DESC_X  = VAL_X - SW * (VAL_Y - BAR_UNDER)

B_left  = arm(ARM_L, CX - GAP, DESC_X, BRK_L, SERIF_IN_L, valley=(VAL_X, VAL_Y))
B_right = arm(ARM_R, CX + GAP, 512 - DESC_X, BRK_R, SERIF_IN_R, mirror=True,
              valley=(512 - VAL_X, VAL_Y))
B_stem  = foot_and_stem(W_APEX, W_BASE, SW, apex_r=6.5)

BODY = squircle(256, 256, 240, 112)
KEY  = squircle(256, 256, 204, 76)

TPL = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="{label}">
  <defs>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2E3031"/><stop offset=".5" stop-color="#252728"/><stop offset="1" stop-color="#1E2021"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5A5C5D" stop-opacity=".75"/>
      <stop offset=".45" stop-color="#5A5C5D" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity=".5"/>
    </linearGradient>
    <linearGradient id="cream" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFBEC"/><stop offset="1" stop-color="#F6EED6"/>
    </linearGradient>
    <linearGradient id="amber" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#F5AD44"/><stop offset="1" stop-color="#EC9C2C"/>
    </linearGradient>
    <filter id="cast" x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="9" stdDeviation="10" flood-color="#15181A" flood-opacity=".3"/>
    </filter>
    <filter id="raise" x="-20%" y="-25%" width="140%" height="150%">
      <feDropShadow dx="0" dy="2.5" stdDeviation="2.5" flood-color="#000" flood-opacity=".5"/>
    </filter>
  </defs>

  <path d="{body}" fill="url(#body)" filter="url(#cast)"/>
  <path d="{body}" fill="none" stroke="url(#rim)" stroke-width="2.5"/>

  <g filter="url(#raise)">
    <path d="{key}" fill="none" stroke="url(#cream)" stroke-width="6.2"/>
    <path d="{left}" fill="url(#cream)"/>
    <path d="{stem}" fill="url(#cream)"/>
    <path d="{right}" fill="url(#amber)"/>
  </g>
</svg>
"""

open('t_round.svg', 'w').write(TPL.format(label="Letter T app icon", body=BODY, key=KEY,
    left=A_left.d(), stem=A_stem.d(), right=A_right.d()))
open('tw.svg', 'w').write(TPL.format(label="T / W monogram app icon", body=BODY, key=KEY,
    left=B_left.d(), stem=B_stem.d(), right=B_right.d()))
print('valley', round(VAL_X, 1), VAL_Y, ' descent starts', round(DESC_X, 1),
      ' wedge base y', round(W_BASE, 1))
print('written')
