#!/usr/bin/env python3
"""Build components / pins / wires / nets from a Proteus ISIS .DSN (reverse engineered)."""
import sys, re, math, bisect, json
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
from dsn import DSN, U, i32, u16, u32

PINLEN = {'$PINDEFAULT': 2 * U, '$PINSHORT': U}
TERNODE = {'$TERGROUND': (0, U), '$TERPOWER': (0, -U), '$TERDEFAULT': (U, 0), '$TERINPUT': (U, 0),
           '$TEROUTPUT': (-U, 0), '$TERBIDIR': (-U, 0)}


def i16(v):
    return v - 65536 if v >= 32768 else v


def xform(pt, ang10, mflags):
    x, y = pt
    if mflags & 1:
        x = -x
    if mflags & 2:
        y = -y
    a = math.radians(ang10 / 10.0)
    c, s = round(math.cos(a)), round(math.sin(a))
    return (x * c - y * s, x * s + y * c)


def g(v):
    r = v / U
    return int(r) if r == int(r) else r


def build(path):
    D = DSN(path)
    d = D.d
    # ---- library names
    pat = re.compile(rb'[A-Z0-9][A-Z0-9_\-\+ ]*\Z')
    names = set()
    for p in range(0, D.lib_end - 2):
        L = d[p]
        if 2 <= L <= 40:
            s_ = d[p + 1:p + 1 + L]
            if pat.match(s_):
                names.add(s_.decode())
    occ = sorted((p, n) for n in names for p in D.find_lenstr(n, 0, D.lib_end))
    ps = [o[0] for o in occ]
    libpins = {}
    for pn in D.lib_pins():
        k = bisect.bisect_left(ps, pn['off']) - 1
        owner = occ[k][1]
        libpins.setdefault(owner, []).append(pn)
    # ---- components
    comps = []
    for n in names:
        if n not in libpins:
            continue
        b = bytes([len(n)]) + n.encode()
        for m in re.finditer(re.escape(b), d[D.obj_start:D.obj_end]):
            p = D.obj_start + m.start()
            npins = u16(d, p - 2)
            if not (1 <= npins <= 200):
                continue
            q = p + 1 + len(n)
            comps.append(dict(off=p, dev=n, npins=npins, x=i32(d, q), y=i32(d, q + 4),
                              ang=i16(u16(d, q + 8)), mflags=d[q + 10], seq=u16(d, q + 12)))
    comps.sort(key=lambda c: c['off'])
    labels = D.labels()
    prev = D.obj_start
    for c in comps:
        ls = [l for l in labels if prev <= l['off'] < c['off']]
        c['labels'] = {l['kind']: l['text'] for l in ls if l['kind'] != 'PROPERTIES'}
        pr = [l for l in ls if l['kind'] == 'PROPERTIES']
        c['props'] = pr[-1]['text'] if pr else ''
        if not c['props'].startswith('{'):
            c['props'] = '(no own block; label text) ' + c['labels'].get('SUBCKT NAME', '')
        c['ref'] = c['labels'].get('COMPONENT ID', '')
        c['value'] = c['labels'].get('COMPONENT VALUE', '')
        prev = c['off']
        c['pins'] = []
        for pn in libpins[c['dev']]:
            L = PINLEN.get(pn['style'], 2 * U)
            node_local = xform((-L, 0), i16(pn['ang']), pn['flip'])
            loc = (pn['x'] + node_local[0], pn['y'] + node_local[1])
            ab = xform(loc, c['ang'], c['mflags'])
            c['pins'].append(dict(name=pn['name'], num=pn['num'], pt=(c['x'] + ab[0], c['y'] + ab[1])))
    # ---- terminals
    terms = []
    for m in re.finditer(rb'\$TER[A-Z]+', d[D.obj_start:D.obj_end]):
        p = D.obj_start + m.start()
        name = m.group().decode()
        if d[p - 1] != len(name):
            continue
        x, y = i32(d, p - 13), i32(d, p - 9)
        ang, mf = i16(u16(d, p - 5)), d[p - 3]
        q = p + len(name)
        lab = ''
        k = d.find(b'\xff', q, q + 8)
        if k >= 0:
            Ln = d[k + 1]
            lab = d[k + 2:k + 2 + Ln].decode('latin1')
        nl = xform(TERNODE.get(name, (0, 0)), ang, mf)
        terms.append(dict(off=p, kind=name, x=x, y=y, ang=ang, mflags=mf, label=lab, pt=(x + nl[0], y + nl[1])))
    wires = D.wires()
    return D, comps, terms, wires, libpins


def on_seg(pt, a, b):
    (x, y), (x1, y1), (x2, y2) = pt, a, b
    if (x - x1) * (y2 - y1) != (y - y1) * (x2 - x1):
        return False
    return min(x1, x2) <= x <= max(x1, x2) and min(y1, y2) <= y <= max(y1, y2)


def nets(comps, terms, wires):
    parent = {}

    def find(a):
        parent.setdefault(a, a)
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    pts = {}  # point -> list of items
    items = []
    for c in comps:
        for p in c['pins']:
            it = ('PIN', c['ref'] or c['dev'] + '@%d' % c['off'], p['name'], p['num'])
            items.append((it, p['pt']))
    for t in terms:
        it = ('TERM', t['kind'], t['label'], '@%s,%s' % (g(t['x']), g(t['y'])))
        items.append((it, t['pt']))
    for k, w in enumerate(wires):
        wid = ('WIRE', k)
        for a, b in zip(w['pts'], w['pts'][1:]):
            pass
        for p_ in w['pts']:
            union(wid, ('PT', p_))
    # endpoints of wires lying on other wires' segments
    for k, w in enumerate(wires):
        for e in (w['pts'][0], w['pts'][-1]):
            for j, w2 in enumerate(wires):
                if j == k:
                    continue
                for a, b in zip(w2['pts'], w2['pts'][1:]):
                    if on_seg(e, a, b):
                        union(('WIRE', k), ('WIRE', j))
    unconnected = []
    for it, pt in items:
        union(it, ('PT', pt))
    groups = {}
    for it, pt in items:
        groups.setdefault(find(it), []).append(it)
    # also check pins touching wire interiors (not real connection in ISIS, just flag)
    flags = []
    for it, pt in items:
        for k, w in enumerate(wires):
            for a, b in zip(w['pts'], w['pts'][1:]):
                if on_seg(pt, a, b) and pt not in (w['pts'][0], w['pts'][-1]) and pt not in w['pts']:
                    flags.append((it, k))
    return list(groups.values()), flags


if __name__ == '__main__':
    path = sys.argv[1]
    D, comps, terms, wires, libpins = build(path)
    print('#', path)
    h = D.header()
    print('HEADER', h)
    for c in comps:
        print('COMP %-6s %-15s val=%-12s at (%s,%s) ang=%d mirror=%d seq=%d' % (c['ref'], c['dev'], c['value'], g(c['x']), g(c['y']), c['ang'], c['mflags'], c['seq']))
        print('      labels:', c['labels'])
        print('      props :', c['props'].replace('\n', ' '))
        for p in c['pins']:
            print('      pin %-12s %-3s -> (%s,%s)' % (p['name'], p['num'], g(p['pt'][0]), g(p['pt'][1])))
    for t in terms:
        print('TERM %-11s label=%r at (%s,%s) ang=%d mf=%d node=(%s,%s)' % (t['kind'], t['label'], g(t['x']), g(t['y']), t['ang'], t['mflags'], g(t['pt'][0]), g(t['pt'][1])))
    for k, w in enumerate(wires):
        print('WIRE %d:' % k, ' -> '.join('(%s,%s)' % (g(x), g(y)) for x, y in w['pts']))
    groups, flags = nets(comps, terms, wires)
    print('NETS:')
    for gr in groups:
        print('   ', ' | '.join(' '.join(str(x) for x in it[1:]) for it in gr))
    if flags:
        print('FLAGS (pin lies on wire interior):', flags)
