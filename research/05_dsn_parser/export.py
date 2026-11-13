#!/usr/bin/env python3
import sys, json, re, datetime, os
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
from netlist import build, nets, g
from dsn import U


def props_dict(txt):
    out = {}
    for m in re.finditer(r'\{([^=}]+)=([^}]*)\}', txt):
        out[m.group(1)] = m.group(2)
    return out


def state_for(D, comp):
    """STATE property stored in the PROPERTIES label just before an RTDSTATE/RTSWITCH part"""
    d = D.d
    seg = d[max(D.obj_start, comp['off'] - 700):comp['off']]
    ms = list(re.finditer(rb'\{STATE=(\d+)\}', seg))
    return ms[-1].group(1).decode() if ms else None


res = {}
for path in sys.argv[1:]:
    D, comps, terms, wires, libpins = build(path)
    h = D.header()
    groups, flags = nets(comps, terms, wires)
    # net id per member
    netid = {}
    for k, gr in enumerate(groups):
        for it in gr:
            netid[it] = k
    C = []
    for c in comps:
        ref = c['ref'] or ''
        key = ref or c['dev'] + '@%d' % c['off']
        pins = []
        for p in c['pins']:
            it = ('PIN', key, p['name'], p['num'])
            pins.append(dict(name=p['name'], num=p['num'], tip=[g(p['pt'][0]), g(p['pt'][1])], net=netid.get(it)))
        pd = props_dict(c['props']) if c['props'].startswith('{') else {}
        st = state_for(D, c) if c['dev'] in ('LOGICSTATE', 'TORCH_LDR') else None
        if st is not None:
            pd.setdefault('STATE', st)
        C.append(dict(ref=ref, device=c['dev'], value=c['value'], origin=[g(c['x']), g(c['y'])],
                      angle=c['ang'] / 10, mirror=c['mflags'], properties=pd, pins=pins, key=key))
    T = [dict(kind=t['kind'], label=t['label'], origin=[g(t['x']), g(t['y'])], angle=t['ang'] / 10,
              node=[g(t['pt'][0]), g(t['pt'][1])]) for t in terms]
    W = [[[g(x), g(y)] for x, y in w['pts']] for w in wires]
    N = []
    for k, gr in enumerate(groups):
        mem = []
        for it in gr:
            if it[0] == 'PIN':
                mem.append('%s.%s' % (it[1], it[2]))
            else:
                mem.append(it[1] + (('(' + it[2] + ')') if it[2] else ''))
        N.append(mem)
    ts = lambda v: datetime.datetime.fromtimestamp(v, datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
    res[os.path.basename(path)] = dict(
        header=dict(created=h['created_str'], modified=h['modified_str'].strip('\x00'),
                    created_ts=ts(h['ts_created']), modified_ts=ts(h['ts_modified']),
                    word_0xA7=h['word_a8'], word_0xA9=h['word_aa']),
        units='grid units: 1 = 100 thou (0.1 inch) = 254000 internal units; Y axis up; angles CCW in degrees',
        components=C, terminals=T, wires=W, nets=[n for n in N if len(n) > 1],
        unconnected=[n[0] for n in N if len(n) == 1])
# friendly keys for unnamed parts
for f, c in res.items():
    cnt = {}
    ren = {}
    for comp in c['components']:
        if not comp['ref']:
            cnt[comp['device']] = cnt.get(comp['device'], 0) + 1
            ren[comp['key']] = '%s#%d' % (comp['device'], cnt[comp['device']])
            comp['key'] = ren[comp['key']]
    def fix(m):
        for a, b in ren.items():
            if m.startswith(a + '.'):
                return b + m[len(a):]
        return m
    c['nets'] = [[fix(m) for m in n] for n in c['nets']]
    c['unconnected'] = [fix(m) for m in c['unconnected']]
print(json.dumps(res, indent=1, ensure_ascii=False))
