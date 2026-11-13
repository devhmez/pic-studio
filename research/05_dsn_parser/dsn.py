#!/usr/bin/env python3
"""Reverse-engineering parser for Proteus ISIS .DSN (binary 'ISIS SCHEMATIC FILE').
Units: 1 internal unit = 10 nm; 254000 units = 100 thou = 1 grid step (0.1 inch). Y axis points UP.
"""
import sys, re, struct, json

U = 254000  # one 100-thou grid step (unit = 10 nm; 2540 units = 1 thou)


def i32(d, o):
    return struct.unpack_from('<i', d, o)[0]


def u32(d, o):
    return struct.unpack_from('<I', d, o)[0]


def u16(d, o):
    return struct.unpack_from('<H', d, o)[0]


class DSN:
    def __init__(self, path):
        self.path = path
        d = self.d = open(path, 'rb').read()
        self.circ = [m.start() for m in re.finditer(rb'ISIS CIRCUIT FILE', d)]
        self.lib_end = self.circ[0]
        self.obj_start = d.find(b'OBJECT DATA', self.circ[0]) + len('OBJECT DATA')
        self.obj_end = self.circ[1]

    # ---------------- header -----------------
    def header(self):
        d = self.d
        h = {}
        h['magic'] = d[:19].decode()
        # dates (mm/dd/yy) at fixed offsets
        h['created_str'] = d[0x6f:0x77].decode('latin1')
        h['modified_str'] = d[0x8b:0x93].decode('latin1')
        h['word_a8'] = u16(d, 0xa7)
        h['word_aa'] = u16(d, 0xa9)
        h['ts_created'] = u32(d, 0xad)
        h['ts_modified'] = u32(d, 0xb1)
        return h

    # ---------------- library -----------------
    def lib_pins(self):
        d = self.d
        out = []
        for m in re.finditer(rb'\$PIN[A-Z]+\x00', d[:self.lib_end]):
            p = m.start()
            pre = d[p - 16:p]
            rot0, flags = pre[0], pre[1]
            x, y = i32(d, p - 12), i32(d, p - 8)
            ang = u16(d, p - 4)
            flip = d[p - 2]
            q = m.end()
            e = d.index(b'\x00', q)
            name = d[q:e].decode('latin1')
            e2 = d.index(b'\x00', e + 1)
            num = d[e + 1:e2].decode('latin1')
            out.append(dict(off=p, style=m.group()[:-1].decode(), b0=rot0, flags=flags, x=x, y=y,
                            ang=ang, flip=flip, name=name, num=num))
        return out

    def lib_markers(self, kind=b'$MKRNODE'):
        d = self.d
        out = []
        for m in re.finditer(re.escape(kind) + rb'\x00', d[:self.lib_end]):
            p = m.start()
            out.append(dict(off=p, x=i32(d, p - 12), y=i32(d, p - 8)))
        return out

    def find_lenstr(self, name, lo=0, hi=None):
        d = self.d
        hi = hi or len(d)
        b = bytes([len(name)]) + name.encode('latin1')
        return [m.start() for m in re.finditer(re.escape(b), d[lo:hi])]

    # ---------------- objects -----------------
    def labels(self):
        """Text labels attached to objects: COMPONENT ID / COMPONENT VALUE / SUBCKT NAME / TERMINAL LABEL / PROPERTIES"""
        d = self.d
        out = []
        for m in re.finditer(rb'Default Font\x00(COMPONENT ID|COMPONENT VALUE|SUBCKT NAME|TERMINAL LABEL|WIRE LABEL|PROPERTIES)\x00',
                             d[self.obj_start:self.obj_end]):
            p = self.obj_start + m.start()
            kind = m.group(1).decode()
            if kind == 'PROPERTIES':
                q = self.obj_start + m.end()
                n = u32(d, q + 4)
                txt = d[q + 8:q + 8 + n]
                out.append(dict(off=p, kind=kind, text=txt.decode('latin1'), n=n))
                continue
            # backward: [u8 len][text][x][y][26 bytes] 'Default Font'
            found = None
            for k in range(0, 250):
                s = p - 26 - 8 - k - 1
                if s < 0:
                    break
                if d[s] == k:
                    found = (k, s)
                    break
            if found:
                k, s = found
                txt = d[s + 1:s + 1 + k].decode('latin1')
                x, y = i32(d, s + 1 + k), i32(d, s + 5 + k)
                out.append(dict(off=p, kind=kind, text=txt, x=x, y=y, lenpos=s))
            else:
                out.append(dict(off=p, kind=kind, text=None))
        return out

    def components(self, devnames):
        d = self.d
        out = []
        for name in devnames:
            b = bytes([len(name)]) + name.encode('latin1')
            for m in re.finditer(re.escape(b), d[self.obj_start:self.obj_end]):
                p = self.obj_start + m.start()
                npins = u16(d, p - 2)
                q = p + 1 + len(name)
                x, y = i32(d, q), i32(d, q + 4)
                tail = d[q + 8:q + 8 + 24]
                out.append(dict(off=p, dev=name, npins=npins, x=x, y=y, tail=tail.hex(' ')))
        out.sort(key=lambda c: c['off'])
        return out

    def wires(self):
        d = self.d
        out = []
        for m in re.finditer(rb'\x7fWIRE\x00', d[self.obj_start:self.obj_end]):
            p = self.obj_start + m.end()
            a = u16(d, p)
            n = u16(d, p + 2)
            pts = [(i32(d, p + 4 + 8 * k), i32(d, p + 8 + 8 * k)) for k in range(n)]
            out.append(dict(off=p, a=a, n=n, pts=pts, after=d[p + 4 + 8 * n:p + 4 + 8 * n + 4].hex(' ')))
        return out

    def terminals(self):
        d = self.d
        out = []
        for m in re.finditer(rb'(\$TER[A-Z]+)', d[self.obj_start:self.obj_end]):
            p = self.obj_start + m.start()
            ln = d[p - 1]
            name = m.group(1).decode()
            if ln != len(name):
                continue
            x, y = i32(d, p - 1 - 12), i32(d, p - 1 - 8)
            rot = d[p - 1 - 4:p - 1].hex(' ')
            q = p + len(name)
            # label: [2 bytes][ff][u8 len][text]
            lab = None
            for k in range(0, 8):
                if d[q + k] == 0xff:
                    L = d[q + k + 1]
                    lab = d[q + k + 2:q + k + 2 + L].decode('latin1')
                    break
            out.append(dict(off=p, kind=name, x=x, y=y, rotbytes=rot, label=lab))
        return out


def gx(v):
    return v / U


if __name__ == '__main__':
    path = sys.argv[1]
    D = DSN(path)
    print('FILE', path, len(D.d), 'circuits at', [hex(c) for c in D.circ], 'obj', hex(D.obj_start), hex(D.obj_end))
    print('HEADER', D.header())
    print('--- LABELS')
    for l in D.labels():
        print(l)
    print('--- WIRES')
    for w in D.wires():
        print(w['off'], w['a'], w['n'], [(gx(x), gx(y)) for x, y in w['pts']], w['after'])
    print('--- TERMINALS')
    for t in D.terminals():
        print(t['kind'], gx(t['x']), gx(t['y']), t['rotbytes'], repr(t['label']))
