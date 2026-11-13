import { describe, expect, it } from 'vitest';
import { Pic16F84A, SFR } from '../src/index';
import { build, C, DC, PD, runToHalt, STATUS, steps, TO, Z } from './helpers';

describe('bank map', () => {
  it('GPR 0x0C–0x4F is mirrored at 0x8C–0xCF', () => {
    const core = build(`
      MOVLW 0x5A
      MOVWF 0x0C        ; bank 0
      BSF STATUS, RP0
      MOVF 0x0C, W      ; bank 1 → 0x8C
      MOVWF 0x4F        ; bank 1 → 0xCF
      BCF STATUS, RP0
      GOTO $
    `);
    runToHalt(core);
    expect(core.w).toBe(0x5a);
    expect(core.peek(0x4f)).toBe(0x5a);
    expect(core.peek(0x8c)).toBe(0x5a);
    expect(core.peek(0xcf)).toBe(0x5a);
  });

  it('unimplemented locations read 0 and ignore writes', () => {
    const core = build(`
      MOVLW 0xFF
      MOVWF 0x50
      MOVWF 0x7F
      MOVWF 0x07
      BSF STATUS, RP0
      MOVWF 0x50        ; 0xD0
      MOVWF 0x07        ; 0x87
      BCF STATUS, RP0
      MOVF 0x50, W
      GOTO $
    `);
    runToHalt(core);
    expect(core.w).toBe(0);
    for (const addr of [0x07, 0x50, 0x7f, 0x87, 0xd0, 0xff, 0x89]) expect(core.peek(addr)).toBe(0);
    expect(core.peek(STATUS) & Z).toBe(Z);
  });

  it('RP0 selects bank 1 for TMR0/OPTION_REG, PORT/TRIS, EEDATA/EECON1', () => {
    const core = build(`
      BSF STATUS, RP0
      MOVLW 0x07
      MOVWF 0x01        ; OPTION_REG
      MOVLW 0x0F
      MOVWF 0x05        ; TRISA
      MOVLW 0xF0
      MOVWF 0x06        ; TRISB
      BCF STATUS, RP0
      MOVLW 0x03
      MOVWF 0x05        ; PORTA latch
      GOTO $
    `);
    runToHalt(core);
    expect(core.peek(SFR.OPTION_REG)).toBe(0x07);
    expect(core.peek(SFR.TRISA)).toBe(0x0f);
    expect(core.peek(SFR.TRISB)).toBe(0xf0);
    expect(core.getDrive('RA0')).toBe('Z'); // RA0 still an input (TRISA = 0x0F)
    expect(core.getDrive('RA4')).toBe(0);
  });

  it('PCL, STATUS, FSR, PCLATH and INTCON are visible in both banks', () => {
    const core = build(`
      MOVLW 0x33
      MOVWF FSR
      MOVLW 0x02
      MOVWF PCLATH
      MOVLW 0x10
      MOVWF INTCON
      BSF STATUS, RP0
      MOVF FSR, W
      MOVWF 0x20
      MOVF PCLATH, W
      MOVWF 0x21
      MOVF INTCON, W
      MOVWF 0x22
      MOVF STATUS, W
      MOVWF 0x23
      GOTO $
    `);
    runToHalt(core);
    expect(core.peek(0x20)).toBe(0x33);
    expect(core.peek(0x21)).toBe(0x02);
    expect(core.peek(0x22)).toBe(0x10);
    expect(core.peek(0x23) & 0x20).toBe(0x20);
    expect(core.peek(0x84)).toBe(0x33);
    expect(core.peek(0x8a)).toBe(0x02);
  });

  it('IRP and RP1 are ignored for bank selection', () => {
    const core = build(`
      BSF STATUS, 6     ; RP1
      BSF STATUS, 7     ; IRP
      MOVLW 0x01
      MOVWF 0x06        ; still bank 0 → PORTB latch, not TRISB
      MOVWF 0x0C
      GOTO $
    `);
    runToHalt(core);
    expect(core.peek(SFR.TRISB)).toBe(0xff);
    expect(core.peek(STATUS) & 0xc0).toBe(0xc0);
    expect(core.peek(0x0c)).toBe(1);
  });

  it('PCL reads the address of the next instruction', () => {
    const core = build(`
      NOP
      NOP
      MOVF PCL, W       ; at 0x002
      GOTO $
    `);
    steps(core, 3);
    expect(core.w).toBe(0x03);
  });

  it('PCLATH has 5 bits', () => {
    const core = build(`
      MOVLW 0xFF
      MOVWF PCLATH
      GOTO $
    `);
    steps(core, 2);
    expect(core.peek(SFR.PCLATH)).toBe(0x1f);
  });
});

describe('indirect addressing (INDF / FSR)', () => {
  it('reads and writes through FSR, with FSR bit 7 selecting bank 1', () => {
    const core = build(`
      MOVLW 0x20
      MOVWF FSR
      MOVLW 0x77
      MOVWF INDF        ; 0x20 ← 0x77
      MOVLW 0xA0
      MOVWF FSR         ; mirror of 0x20
      MOVF INDF, W
      MOVWF 0x21
      MOVLW 0x86
      MOVWF FSR         ; TRISB, whatever RP0 says
      CLRF INDF
      GOTO $
    `);
    runToHalt(core);
    expect(core.peek(0x20)).toBe(0x77);
    expect(core.peek(0x21)).toBe(0x77);
    expect(core.peek(SFR.TRISB)).toBe(0x00);
    expect(core.peek(SFR.INDF)).toBe(0x00); // peek INDF follows FSR (TRISB = 0)
  });

  it('INDF through FSR = 0 reads 0 and writing it is a no-operation', () => {
    const core = build(`
      CLRF FSR
      MOVLW 0x55
      MOVWF INDF
      MOVF INDF, W
      MOVWF 0x20
      MOVLW 0x80
      MOVWF FSR
      MOVF INDF, W
      MOVWF 0x21
      GOTO $
    `);
    core.poke(0x20, 0xaa);
    runToHalt(core);
    expect(core.peek(0x20)).toBe(0);
    expect(core.peek(0x21)).toBe(0);
    expect(core.peek(STATUS) & Z).toBe(Z);
  });

  it('clears RAM with the classic FSR loop', () => {
    const core = build(`
      MOVLW 0x0C
      MOVWF FSR
next: CLRF INDF
      INCF FSR, F
      MOVLW 0x50
      SUBWF FSR, W
      BTFSS STATUS, Z
      GOTO next
      GOTO $
    `);
    for (let a = 0x0c; a <= 0x4f; a++) core.poke(a, a);
    runToHalt(core);
    for (let a = 0x0c; a <= 0x4f; a++) expect(core.peek(a)).toBe(0);
    expect(core.peek(SFR.FSR)).toBe(0x50);
  });
});

describe('STATUS write rules', () => {
  function runStatus(code: string, initial: number): number {
    const core = build(`${code}\n GOTO $`);
    core.poke(STATUS, initial);
    runToHalt(core);
    return core.peek(STATUS);
  }

  it('CLRF STATUS → 000u u1uu (Z = 1: the flag result wins)', () => {
    expect(runStatus('CLRF STATUS', 0x18)).toBe(0x1c);
    expect(runStatus('CLRF STATUS', 0xff)).toBe(0x1f);
    expect(runStatus('CLRF STATUS', 0x03)).toBe(0x07);
  });

  it('MOVWF STATUS writes Z/DC/C but never TO/PD', () => {
    expect(runStatus('MOVLW 0x00\n MOVWF STATUS', 0x1f)).toBe(0x18);
    expect(runStatus('MOVLW 0x07\n MOVWF STATUS', 0x18)).toBe(0x1f);
    expect(runStatus('MOVLW 0x00\n MOVWF STATUS', 0x00)).toBe(0x00);
    expect(runStatus('MOVLW 0xFF\n MOVWF STATUS', 0x00)).toBe(0xe7);
  });

  it('BCF/BSF cannot change TO and PD', () => {
    expect(runStatus('BCF STATUS, TO\n BCF STATUS, PD', 0x18)).toBe(0x18);
    expect(runStatus('BSF STATUS, TO\n BSF STATUS, PD', 0x00)).toBe(0x00);
    expect(runStatus('BSF STATUS, C\n BSF STATUS, Z', 0x18)).toBe(0x18 | C | Z);
  });

  it('ALU result written to STATUS: C/DC/Z come from the operation, not from the result value', () => {
    // 0x18 + 1 = 0x19: bit 0 of the result is not written; C = 0 from the addition.
    expect(runStatus('MOVLW 0x01\n ADDWF STATUS, F', 0x18)).toBe(0x18);
    // INCF STATUS,F: Z from the result (0x19 ≠ 0), C/DC unchanged.
    expect(runStatus('INCF STATUS, F', 0x18 | C)).toBe(0x18 | C);
    // RLF STATUS,F: bits 7..5 from the rotation (RP0 = 1), C = old bit 7.
    expect(runStatus('RLF STATUS, F', 0x18)).toBe(0x38);
    // SWAPF does not affect flags, so its result is written (except TO/PD).
    expect(runStatus('SWAPF STATUS, F', 0x18)).toBe(0x99);
  });

  it('the prof\'s STATUS=0 as CLRF leaves Z = 1, as MOVLW/MOVWF leaves Z = 0', () => {
    expect(runStatus('CLRF STATUS', 0x18) & Z).toBe(Z);
    expect(runStatus('MOVLW 0\n MOVWF STATUS', 0x18) & Z).toBe(0);
  });
});

describe('reset values (DS35007 Tables 6-3 / 6-4)', () => {
  it('power-on reset', () => {
    const core = new Pic16F84A();
    const s = core.snapshot();
    expect(s.pc).toBe(0);
    expect(s.w).toBe(0);
    expect(s.status).toBe(0x18);
    expect(s.file[SFR.OPTION_REG]).toBe(0xff);
    expect(s.file[SFR.TRISA]).toBe(0x1f);
    expect(s.file[SFR.TRISB]).toBe(0xff);
    expect(s.file[SFR.INTCON]).toBe(0);
    expect(s.file[SFR.PCLATH]).toBe(0);
    expect(s.file[SFR.EECON1]).toBe(0);
    expect(s.file[SFR.TMR0]).toBe(0);
    expect(s.file[SFR.FSR]).toBe(0);
    expect(s.stack).toEqual([]);
    expect(s.cycles).toBe(0);
    expect(s.sleeping).toBe(false);
    expect(s.halted).toBe(false);
    expect([...s.file.subarray(0x0c, 0x50)].every((v) => v === 0)).toBe(true);
    expect(s.eeprom.every((v) => v === 0xff)).toBe(true);
    expect(core.clockHz).toBe(1_000_000);
    expect(core.tcy).toBeCloseTo(4e-6, 12);
    expect(core.config).toBe(0x3ffb);
  });

  function dirtyCore(): Pic16F84A {
    const core = build(`
      MOVLW 0x5A
      MOVWF 0x20
      MOVWF PORTB
      MOVWF FSR
      MOVLW 0x03
      MOVWF PCLATH
      MOVLW 0x79        ; EEIE T0IE INTE RBIE + RBIF (GIE off)
      MOVWF INTCON
      BSF STATUS, RP0
      CLRF TRISB
      CLRF OPTION_REG
      BSF STATUS, Z
      GOTO $
    `);
    runToHalt(core);
    return core;
  }

  it('MCLR reset in normal operation: 000u uuuu, RAM and latches kept', () => {
    const core = dirtyCore();
    expect(core.peek(STATUS) & 0x20).toBe(0x20);
    core.reset('mclr');
    expect(core.pc).toBe(0);
    expect(core.peek(STATUS)).toBe(0x18 | Z);
    expect(core.w).toBe(0x79);
    expect(core.peek(0x20)).toBe(0x5a);
    expect(core.peek(SFR.FSR)).toBe(0x5a);
    expect(core.peek(SFR.PCLATH)).toBe(0);
    expect(core.peek(SFR.INTCON)).toBe(0x01); // 0000 000u
    expect(core.peek(SFR.OPTION_REG)).toBe(0xff);
    expect(core.peek(SFR.TRISB)).toBe(0xff);
    expect(core.getDrive('RB1')).toBe('Z');
    core.poke(SFR.TRISB, 0);
    expect(core.getDrive('RB1')).toBe(1); // latch 0x5A kept
  });

  it('MCLR reset during SLEEP: 0001 0uuu', () => {
    const core = build('BSF STATUS, C\n SLEEP\n GOTO $');
    steps(core, 3);
    expect(core.sleeping).toBe(true);
    core.reset('mclr');
    expect(core.peek(STATUS)).toBe(TO | C);
    expect(core.sleeping).toBe(false);
  });

  it('WDT reset: 0000 1uuu', () => {
    const core = dirtyCore();
    core.reset('wdt');
    expect(core.peek(STATUS)).toBe(PD | Z);
    expect(core.peek(SFR.TRISB)).toBe(0xff);
    expect(core.peek(0x20)).toBe(0x5a);
  });

  it('power-on reset clears RAM and the latches but keeps the EEPROM', () => {
    const core = dirtyCore();
    core.pokeEeprom(3, 0x42);
    core.reset('por');
    expect(core.peek(0x20)).toBe(0);
    expect(core.peek(STATUS)).toBe(0x18);
    expect(core.w).toBe(0);
    expect(core.peekEeprom(3)).toBe(0x42);
    core.poke(SFR.TRISB, 0);
    expect(core.getDrive('RB1')).toBe(0);
  });

  it('flags DC and C are kept by MCLR (u)', () => {
    const core = build('BSF STATUS, C\n BSF STATUS, DC\n GOTO $');
    runToHalt(core);
    core.reset('mclr');
    expect(core.peek(STATUS)).toBe(0x18 | C | DC);
  });
});
