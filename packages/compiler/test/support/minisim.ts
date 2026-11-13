// Minimal PIC16F84A reference simulator used ONLY by the compiler's own tests, so that code generation can be
// checked independently of @pic/emulator (which the e2e tests use). Datasheet DS35007 semantics for the
// instruction set, STATUS writes, banking, PCL/PCLATH, the 8-level stack, ports, EEPROM and INT/RB interrupts.

export type Level = 0 | 1;
const PINS = ['RA0', 'RA1', 'RA2', 'RA3', 'RA4', 'RB0', 'RB1', 'RB2', 'RB3', 'RB4', 'RB5', 'RB6', 'RB7'] as const;
export type Pin = (typeof PINS)[number];

const STATUS = 0x03;
const FSR = 0x04;
const PCL = 0x02;
const PCLATH = 0x0a;
const INTCON = 0x0b;

export class MiniSim {
  readonly clockHz: number;
  private prog = new Uint16Array(1024).fill(0x3fff);
  /** Canonical register storage indexed by canonical address (bank-1 SFRs at 0x80+). */
  private ram = new Uint8Array(256);
  private latchA = 0;
  private latchB = 0;
  private inA = 0;
  private inB = 0;
  w = 0;
  pc = 0;
  cycles = 0;
  private stack: number[] = [];
  readonly eeprom = new Uint8Array(64).fill(0xff);
  private eeUnlock = 0;
  private eeWriteDone = -1;
  halted = false;

  constructor(opts: { clockHz?: number } = {}) {
    this.clockHz = opts.clockHz ?? 1_000_000;
    this.reset();
  }

  load(program: Uint16Array): void {
    this.prog = new Uint16Array(program);
    this.reset();
  }

  reset(): void {
    this.ram.fill(0);
    this.ram[STATUS] = 0x18;
    this.ram[0x81] = 0xff; // OPTION_REG
    this.ram[0x85] = 0x1f; // TRISA
    this.ram[0x86] = 0xff; // TRISB
    this.pc = 0;
    this.w = 0;
    this.cycles = 0;
    this.stack = [];
    this.halted = false;
  }

  // -------------------------------------------------------------------------------------------------
  // Register file

  private canonical(addr: number): number | null {
    const a = addr & 0xff;
    const low = a & 0x7f;
    if (low >= 0x0c && low <= 0x4f) return low;
    if ([0x00, 0x02, 0x03, 0x04, 0x0a, 0x0b].includes(low)) return low;
    if (a <= 0x09 && a !== 0x07) return a;
    if ([0x81, 0x85, 0x86, 0x88, 0x89].includes(a)) return a;
    return null;
  }

  private fileAddr(f: number): number {
    const rp0 = (this.ram[STATUS] >> 5) & 1;
    return (rp0 << 7) | (f & 0x7f);
  }

  read(addr: number): number {
    let c = this.canonical(addr);
    if (c === 0x00) c = this.canonical(this.ram[FSR]);
    if (c === null || c === 0x00) return 0;
    if (c === 0x05) return ((this.ram[0x85] & this.inA) | (~this.ram[0x85] & this.latchA)) & 0x1f;
    if (c === 0x06) return ((this.ram[0x86] & this.inB) | (~this.ram[0x86] & this.latchB)) & 0xff;
    if (c === PCL) return this.pc & 0xff;
    return this.ram[c];
  }

  write(addr: number, v: number): void {
    let c = this.canonical(addr);
    if (c === 0x00) c = this.canonical(this.ram[FSR]);
    if (c === null || c === 0x00) return;
    v &= 0xff;
    switch (c) {
      case 0x05: this.latchA = v & 0x1f; return;
      case 0x06: this.latchB = v; return;
      case STATUS: this.ram[STATUS] = (this.ram[STATUS] & 0x18) | (v & 0xe7); return;
      case PCL: this.pc = ((this.ram[PCLATH] & 0x1f) << 8) | v; this.pcWritten = true; return;
      case 0x89: this.eeUnlock = v === 0x55 ? 1 : v === 0xaa && this.eeUnlock === 1 ? 2 : 0; return;
      case 0x88: {
        const old = this.ram[0x88];
        let nv = (old & 0x03) | (v & 0x1c); // RD/WR can only be set by software
        if (v & 1) {
          this.ram[0x08] = this.eeprom[this.ram[0x09] & 0x3f];
        }
        if (v & 2 && old & 4 && this.eeUnlock === 2) {
          nv |= 2;
          this.eeWriteDone = this.cycles + Math.round(0.004 * this.clockHz / 4);
        }
        this.eeUnlock = 0;
        this.ram[0x88] = nv & ~1;
        return;
      }
      default:
        this.ram[c] = v;
    }
  }

  peek(addr: number): number {
    const c = this.canonical(addr);
    return c === null ? 0 : c === 0x05 ? this.latchA : c === 0x06 ? this.latchB : this.ram[c];
  }

  private pcWritten = false;

  poke(addr: number, value: number): void {
    const c = this.canonical(addr);
    if (c === null) return;
    if (c === 0x05) this.latchA = value & 0x1f;
    else if (c === 0x06) this.latchB = value & 0xff;
    else this.ram[c] = value & 0xff;
  }

  // -------------------------------------------------------------------------------------------------
  // Pins

  setInput(pin: Pin, level: Level): void {
    const isA = pin.startsWith('RA');
    const bit = Number(pin.slice(2));
    if (isA) {
      this.inA = level ? this.inA | (1 << bit) : this.inA & ~(1 << bit);
      return;
    }
    const old = (this.inB >> bit) & 1;
    this.inB = level ? this.inB | (1 << bit) : this.inB & ~(1 << bit);
    if (bit === 0 && old !== level) {
      const intedg = (this.ram[0x81] >> 6) & 1;
      if (level === intedg) this.ram[INTCON] |= 0x02; // INTF
    }
    if (bit >= 4 && old !== level && (this.ram[0x86] >> bit) & 1) this.ram[INTCON] |= 0x01; // RBIF
  }

  getDrive(pin: Pin): 0 | 1 | 'Z' {
    const isA = pin.startsWith('RA');
    const bit = Number(pin.slice(2));
    const tris = isA ? this.ram[0x85] : this.ram[0x86];
    if ((tris >> bit) & 1) return 'Z';
    const v = ((isA ? this.latchA : this.latchB) >> bit) & 1;
    if (isA && bit === 4) return v ? 'Z' : 0;
    return v as 0 | 1;
  }

  // -------------------------------------------------------------------------------------------------
  // Execution

  private setZ(r: number): void {
    if ((r & 0xff) === 0) this.ram[STATUS] |= 0x04;
    else this.ram[STATUS] &= ~0x04;
  }

  private setFlag(mask: number, on: boolean): void {
    if (on) this.ram[STATUS] |= mask;
    else this.ram[STATUS] &= ~mask;
  }

  /** Store an ALU result; when the destination is STATUS, the instruction's own flag bits win. */
  private dest(d: number, f: number, r: number, flagMask: number): void {
    if (!d) {
      this.w = r & 0xff;
      return;
    }
    const addr = this.fileAddr(f);
    if (this.canonical(addr) === STATUS && flagMask) {
      const keep = this.ram[STATUS] & flagMask;
      this.write(addr, r);
      this.ram[STATUS] = (this.ram[STATUS] & ~flagMask) | keep;
    } else this.write(addr, r);
  }

  private interrupt(): void {
    const i = this.ram[INTCON];
    if (!(i & 0x80)) return;
    const eeif = (this.ram[0x88] >> 4) & 1;
    if ((i & 0x20 && i & 0x04) || (i & 0x10 && i & 0x02) || (i & 0x08 && i & 0x01) || (i & 0x40 && eeif)) {
      this.push(this.pc);
      this.ram[INTCON] &= ~0x80;
      this.pc = 4;
      this.cycles += 2;
    }
  }

  private push(a: number): void {
    this.stack.push(a & 0x1fff);
    if (this.stack.length > 8) this.stack.shift();
  }

  private tickTimers(n: number): void {
    for (let k = 0; k < n; k++) {
      if (this.eeWriteDone >= 0 && this.cycles >= this.eeWriteDone) {
        this.eeprom[this.ram[0x09] & 0x3f] = this.ram[0x08];
        this.ram[0x88] = (this.ram[0x88] & ~2) | 0x10;
        this.eeWriteDone = -1;
      }
      if (!((this.ram[0x81] >> 5) & 1)) {
        this.ram[0x01] = (this.ram[0x01] + 1) & 0xff;
        if (this.ram[0x01] === 0) this.ram[INTCON] |= 0x04;
      }
    }
  }

  step(): { cycles: number; pc: number } {
    this.halted = false;
    this.interrupt();
    const pc = this.pc;
    const op = this.prog[pc & 0x3ff];
    let cyc = 1;
    this.pcWritten = false;
    let next = (pc + 1) & 0x1fff;
    const f = op & 0x7f;
    const d = (op >> 7) & 1;
    const b = (op >> 7) & 7;
    const k = op & 0xff;
    const C = 1, DC = 2, Z = 4;
    const top = op >> 12;
    const rd = () => this.read(this.fileAddr(f));
    const add = (a: number, c: number) => {
      const r = a + c;
      this.setFlag(C, r > 0xff);
      this.setFlag(DC, (a & 0xf) + (c & 0xf) > 0xf);
      this.setZ(r);
      return r & 0xff;
    };
    const sub = (a: number, c: number) => {
      // a − c computed as a + ~c + 1 (C = no borrow)
      const r = a + ((~c & 0xff) + 1);
      this.setFlag(C, a >= c);
      this.setFlag(DC, (a & 0xf) >= (c & 0xf));
      this.setZ(r);
      return r & 0xff;
    };
    if (top === 0) {
      const sub6 = (op >> 8) & 0x3f;
      switch (sub6) {
        case 0x00:
          if (op & 0x80) this.write(this.fileAddr(f), this.w); // MOVWF
          else if (op === 0x0008) { next = this.stack.pop() ?? 0; cyc = 2; } // RETURN
          else if (op === 0x0009) { next = this.stack.pop() ?? 0; this.ram[INTCON] |= 0x80; cyc = 2; } // RETFIE
          break; // NOP, CLRWDT, SLEEP ignored
        case 0x01:
          if (op & 0x80) { this.dest(1, f, 0, Z); this.ram[STATUS] |= Z; } // CLRF
          else { this.w = 0; this.ram[STATUS] |= Z; } // CLRW
          break;
        case 0x02: { const r = sub(rd(), this.w); this.dest(d, f, r, C | DC | Z); break; } // SUBWF
        case 0x03: { const r = (rd() - 1) & 0xff; this.setZ(r); this.dest(d, f, r, Z); break; } // DECF
        case 0x04: { const r = rd() | this.w; this.setZ(r); this.dest(d, f, r, Z); break; } // IORWF
        case 0x05: { const r = rd() & this.w; this.setZ(r); this.dest(d, f, r, Z); break; } // ANDWF
        case 0x06: { const r = rd() ^ this.w; this.setZ(r); this.dest(d, f, r, Z); break; } // XORWF
        case 0x07: { const r = add(rd(), this.w); this.dest(d, f, r, C | DC | Z); break; } // ADDWF
        case 0x08: { const r = rd(); this.setZ(r); this.dest(d, f, r, Z); break; } // MOVF
        case 0x09: { const r = ~rd() & 0xff; this.setZ(r); this.dest(d, f, r, Z); break; } // COMF
        case 0x0a: { const r = (rd() + 1) & 0xff; this.setZ(r); this.dest(d, f, r, Z); break; } // INCF
        case 0x0b: { const r = (rd() - 1) & 0xff; this.dest(d, f, r, 0); if (r === 0) { next = (next + 1) & 0x1fff; cyc = 2; } break; } // DECFSZ
        case 0x0c: { const v = rd(); const r = ((v >> 1) | ((this.ram[STATUS] & C) << 7)) & 0xff; this.setFlag(C, (v & 1) === 1); this.dest(d, f, r, C); break; } // RRF
        case 0x0d: { const v = rd(); const r = ((v << 1) | (this.ram[STATUS] & C)) & 0xff; this.setFlag(C, (v & 0x80) !== 0); this.dest(d, f, r, C); break; } // RLF
        case 0x0e: { const v = rd(); this.dest(d, f, ((v << 4) | (v >> 4)) & 0xff, 0); break; } // SWAPF
        case 0x0f: { const r = (rd() + 1) & 0xff; this.dest(d, f, r, 0); if (r === 0) { next = (next + 1) & 0x1fff; cyc = 2; } break; } // INCFSZ
      }
    } else if (top === 1) {
      const kind = (op >> 10) & 3;
      const addr = this.fileAddr(f);
      const v = this.read(addr);
      if (kind === 0) this.dest(1, f, v & ~(1 << b), 0); // BCF
      else if (kind === 1) this.dest(1, f, v | (1 << b), 0); // BSF
      else if (kind === 2) { if (!((v >> b) & 1)) { next = (next + 1) & 0x1fff; cyc = 2; } } // BTFSC
      else { if ((v >> b) & 1) { next = (next + 1) & 0x1fff; cyc = 2; } } // BTFSS
    } else if (top === 2) {
      const target = ((this.ram[PCLATH] & 0x18) << 8) | (op & 0x7ff);
      if (op & 0x800) { if (target === pc) this.halted = true; next = target; } // GOTO
      else { this.push(next); next = target; } // CALL
      cyc = 2;
    } else {
      const s = (op >> 8) & 0x3f;
      if ((s & 0x3c) === 0x30) this.w = k; // MOVLW
      else if ((s & 0x3c) === 0x34) { this.w = k; next = this.stack.pop() ?? 0; cyc = 2; } // RETLW
      else if (s === 0x38) { this.w = this.w | k; this.setZ(this.w); } // IORLW
      else if (s === 0x39) { this.w = this.w & k; this.setZ(this.w); } // ANDLW
      else if (s === 0x3a) { this.w = this.w ^ k; this.setZ(this.w); } // XORLW
      else if ((s & 0x3e) === 0x3c) this.w = sub(k, this.w); // SUBLW
      else if ((s & 0x3e) === 0x3e) this.w = add(k, this.w); // ADDLW
    }
    if (this.pcWritten) {
      cyc = 2;
      next = this.pc;
    }
    this.pc = next;
    this.cycles += cyc;
    this.tickTimers(cyc);
    return { cycles: cyc, pc };
  }

  /** Run until `pred` holds or `maxCycles` elapse. */
  runUntil(pred: () => boolean, maxCycles = 2_000_000): void {
    const end = this.cycles + maxCycles;
    while (!pred() && this.cycles < end) this.step();
  }

  runCycles(n: number): void {
    const end = this.cycles + n;
    while (this.cycles < end && !this.halted) this.step();
  }
}
