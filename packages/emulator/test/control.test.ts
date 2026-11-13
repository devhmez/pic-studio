import { describe, expect, it } from 'vitest';
import { SFR } from '../src/index';
import { build, runToHalt, steps, stepUntilPc } from './helpers';

describe('GOTO / CALL / RETURN', () => {
  it('take 2 cycles and use the stack', () => {
    const core = build(`
      CALL sub          ; 0
      GOTO $            ; 1
sub:  MOVLW 0x42        ; 2
      RETURN            ; 3
    `);
    let r = core.step();
    expect(r).toMatchObject({ cycles: 2, pc: 0 });
    expect(core.pc).toBe(2);
    expect(core.snapshot().stack).toEqual([1]);
    expect(core.step().cycles).toBe(1);
    r = core.step();
    expect(r).toMatchObject({ cycles: 2, pc: 3 });
    expect(core.pc).toBe(1);
    expect(core.snapshot().stack).toEqual([]);
    expect(core.w).toBe(0x42);
    expect(core.step().cycles).toBe(2);
    expect(core.halted).toBe(true);
  });

  it('GOTO/CALL take PC<12:11> from PCLATH<4:3>; fetch wraps to the 1K implemented', () => {
    const core = build(`
      MOVLW 0x18
      MOVWF PCLATH
      GOTO 0x010
      ORG 0x010
      MOVLW 0x77
      CALL 0x020
      ORG 0x020
      RETURN
    `);
    steps(core, 3);
    expect(core.pc).toBe(0x1810);
    steps(core, 1);
    expect(core.w).toBe(0x77);
    steps(core, 1);
    expect(core.pc).toBe(0x1820);
    expect(core.snapshot().stack).toEqual([0x1812]);
    steps(core, 1);
    expect(core.pc).toBe(0x1812);
  });

  it('GOTO ignores PCLATH<2:0>', () => {
    const core = build(`
      MOVLW 0x07
      MOVWF PCLATH
      GOTO 0x005
      ORG 0x005
      GOTO $
    `);
    steps(core, 3);
    expect(core.pc).toBe(0x005);
  });

  it('PC increments past 0x3FF into the unimplemented space and fetch wraps to 0x000', () => {
    const core = build(`
      MOVLW 0x42
      GOTO $
      ORG 0x3FF
      NOP
    `);
    core.setPc(0x3ff);
    core.step();
    expect(core.pc).toBe(0x400);
    const r = core.step();
    expect(r.opcode).toBe(0x3042);
    expect(core.w).toBe(0x42);
    expect(core.pc).toBe(0x401);
  });
});

describe('PCL / PCLATH computed jumps', () => {
  it('MOVWF PCL loads PCLATH<4:0>:W and takes 2 cycles', () => {
    const core = build(`
      MOVLW 0x02
      MOVWF PCLATH
      MOVLW 0x10
      MOVWF PCL
      ORG 0x210
      GOTO $
    `);
    steps(core, 3);
    const r = core.step();
    expect(r.cycles).toBe(2);
    expect(core.pc).toBe(0x210);
  });

  it('RETLW table via ADDWF PCL,F (7-segment decoding)', () => {
    const core = build(`
      MOVF 0x20, W
      CALL table
      MOVWF 0x21
      GOTO $
table:
      ADDWF PCL, F
      RETLW 0x3F        ; 0
      RETLW 0x06        ; 1
      RETLW 0x5B        ; 2
      RETLW 0x4F        ; 3
      RETLW 0x66        ; 4
    `);
    for (const [digit, seg] of [[0, 0x3f], [1, 0x06], [3, 0x4f], [4, 0x66]]) {
      core.reset('por');
      core.poke(0x20, digit);
      runToHalt(core);
      expect(core.peek(0x21)).toBe(seg);
    }
  });

  it('table across a 256-word page uses PCLATH', () => {
    const core = build(`
      MOVLW HIGH_TABLE
      MOVWF PCLATH
      MOVLW 2
      CALL table
      MOVWF 0x21
      GOTO $
HIGH_TABLE EQU 0x01
      ORG 0x1FD
table:
      ADDWF PCL, F      ; 0x1FD → PCL = 0xFE + 2 = 0x00 (carry lost), page from PCLATH
      RETLW 0xA0        ; 0x1FE
      RETLW 0xA1        ; 0x1FF
      ORG 0x100
      RETLW 0xB0        ; reached because PCLATH still says page 1
    `);
    runToHalt(core);
    expect(core.peek(0x21)).toBe(0xb0);
  });

  it('every write to PCL is a 2-cycle jump (BSF, CLRF, INCF, ADDWF)', () => {
    for (const ins of ['CLRF PCL', 'INCF PCL, F', 'BSF PCL, 4', 'ADDWF PCL, F']) {
      const core = build(`
        NOP
        ${ins}
        GOTO $
      `);
      core.setW(0x10);
      core.step();
      const r = core.step();
      expect(r.cycles).toBe(2);
    }
    const core = build('NOP\n BSF PCL, 4');
    steps(core, 2);
    expect(core.pc).toBe(0x12);
  });

  it('a write of PCL with W destination is a plain read (1 cycle)', () => {
    const core = build('MOVF PCL, W\n GOTO $');
    expect(core.step().cycles).toBe(1);
    expect(core.pc).toBe(1);
  });
});

describe('8-level hardware stack', () => {
  // s1..s9: nine nested CALLs. Return addresses pushed: 1, 3, 5, ..., 17.
  const nested = `
      CALL s1           ; 0
      GOTO $            ; 1
s1:   CALL s2           ; 2
      RETURN            ; 3
s2:   CALL s3
      RETURN
s3:   CALL s4
      RETURN
s4:   CALL s5
      RETURN
s5:   CALL s6
      RETURN
s6:   CALL s7
      RETURN
s7:   CALL s8
      RETURN
s8:   CALL s9           ; 16
      RETURN            ; 17
s9:   RETURN            ; 18
  `;

  it('eight nested calls return correctly', () => {
    const core = build(nested.replace('s8:   CALL s9           ; 16', 's8:   NOP'));
    runToHalt(core);
    expect(core.pc).toBe(1);
    expect(core.stackOverflow).toBe(false);
  });

  it('a 9th push overwrites the oldest return address (the program never gets back)', () => {
    const core = build(nested);
    stepUntilPc(core, 18);
    expect(core.snapshot().stack).toEqual([3, 5, 7, 9, 11, 13, 15, 17]);
    expect(core.stackOverflow).toBe(true);
    // Returns: 17, 15, ..., 3, then the overwritten slot sends execution back to 17.
    const visited: number[] = [];
    for (let i = 0; i < 30; i++) {
      core.step();
      visited.push(core.pc);
    }
    expect(visited.slice(0, 9)).toEqual([17, 15, 13, 11, 9, 7, 5, 3, 17]);
    expect(visited).not.toContain(1);
  });

  it('RETURN with an empty stack is flagged as underflow', () => {
    const core = build('RETURN');
    core.step();
    expect(core.stackUnderflow).toBe(true);
    expect(core.pc).toBe(0);
  });
});

describe('halt detection (GOTO $)', () => {
  it('reports halted while executing GOTO to its own address, and keeps stepping', () => {
    const core = build(`
      MOVLW 1
      GOTO $
    `);
    core.step();
    expect(core.halted).toBe(false);
    for (let i = 0; i < 3; i++) {
      const r = core.step();
      expect(r).toMatchObject({ pc: 1, cycles: 2 });
      expect(core.halted).toBe(true);
    }
    expect(core.snapshot().halted).toBe(true);
    expect(core.cycles).toBe(7);
  });

  it('a backward GOTO loop is not halted', () => {
    const core = build('loop: NOP\n GOTO loop');
    steps(core, 4);
    expect(core.halted).toBe(false);
  });
});

describe('cycle counting', () => {
  it('counts 1- and 2-cycle instructions', () => {
    const core = build(`
      MOVLW 3           ; 1
      MOVWF 0x20        ; 1
loop: DECFSZ 0x20, F    ; 1,1,2
      GOTO loop         ; 2,2
      CALL sub          ; 2
      RETLW 0           ; never reached
sub:  RETLW 5           ; 2
    `);
    stepUntilPc(core, 4);
    // MOVLW 1 + MOVWF 1 + (DECFSZ 1 + GOTO 2) × 2 + DECFSZ skipping 2 = 10
    expect(core.cycles).toBe(10);
    core.step();
    core.step();
    expect(core.cycles).toBe(14);
    expect(core.w).toBe(5);
    expect(core.peek(SFR.PCL)).toBe(5);
  });
});

describe('legacy and unassigned opcodes', () => {
  it('OPTION and TRIS load OPTION_REG / TRISx from W', () => {
    const core = build(`
      MOVLW 0x07
      OPTION
      MOVLW 0x0F
      TRIS PORTB
      MOVLW 0x03
      TRIS PORTA
      GOTO $
    `);
    runToHalt(core);
    expect(core.peek(SFR.OPTION_REG)).toBe(0x07);
    expect(core.peek(SFR.TRISB)).toBe(0x0f);
    expect(core.peek(SFR.TRISA)).toBe(0x03);
  });

  it('unassigned opcodes execute as a 1-cycle NOP', () => {
    const core = build('DW 0x0001\n DW 0x3B00\n GOTO $');
    core.poke(SFR.STATUS, 0x1f);
    expect(core.step().cycles).toBe(1);
    expect(core.step().cycles).toBe(1);
    expect(core.pc).toBe(2);
    expect(core.peek(SFR.STATUS)).toBe(0x1f);
    expect(core.w).toBe(0);
  });
});
