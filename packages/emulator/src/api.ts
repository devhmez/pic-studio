// Public contract of the PIC16F84A emulator. The circuit simulator and the UI depend only on these types.

/** Names of the 13 GPIO pins. */
export type PinName =
  | 'RA0' | 'RA1' | 'RA2' | 'RA3' | 'RA4'
  | 'RB0' | 'RB1' | 'RB2' | 'RB3' | 'RB4' | 'RB5' | 'RB6' | 'RB7';

export const PIN_NAMES: readonly PinName[] = [
  'RA0', 'RA1', 'RA2', 'RA3', 'RA4',
  'RB0', 'RB1', 'RB2', 'RB3', 'RB4', 'RB5', 'RB6', 'RB7',
];

/** Physical DIP-18 pin number for each GPIO (datasheet). */
export const PIN_NUMBER: Readonly<Record<PinName, number>> = {
  RA2: 1, RA3: 2, RA4: 3, RB0: 6, RB1: 7, RB2: 8, RB3: 9,
  RB4: 10, RB5: 11, RB6: 12, RB7: 13, RA0: 17, RA1: 18,
};

/** What the MCU itself drives onto a pin. 'Z' = not driving (input, or RA4 open-drain released). */
export type Drive = 0 | 1 | 'Z';

/** Resolved level of the net a pin sits on, as computed by the circuit. 'Z' floating, 'X' contention/unknown. */
export type Level = 0 | 1 | 'Z' | 'X';

/**
 * The electrical boundary between the MCU and the circuit simulator.
 * The circuit reads getDrive()/hasWeakPullup() for every pin, solves the nets,
 * then calls setInput() with the resolved level of each pin's net.
 */
export interface McuPins {
  readonly pinNames: readonly PinName[];
  /** Current output drive of the pin (TRIS bit 0 → PORT latch value; RA4 drives only 0, else 'Z'). */
  getDrive(pin: PinName): Drive;
  /** True when PORTB weak pull-ups are enabled (OPTION_REG.RBPU = 0) and the pin is an input. Always false on PORTA. */
  hasWeakPullup(pin: PinName): boolean;
  /**
   * Tell the MCU the level present on the pin. Reads of PORTx return this for input pins.
   * Floating ('Z') and 'X' read as an implementation-defined but stable value (use the last defined level, default 0).
   * Edges on RB0/INT and changes on RB4–RB7 (while inputs) must raise INTF/RBIF exactly like the datasheet.
   */
  setInput(pin: PinName, level: Level): void;
}

export interface StepResult {
  /** Instruction cycles consumed (1 or 2; 0 while sleeping). A halted core ("GOTO $") still reports its real 2 cycles. */
  cycles: number;
  /** Address of the executed instruction. */
  pc: number;
  /** Raw 14-bit opcode executed. */
  opcode: number;
  /** True if PORTA/PORTB latches or TRISA/TRISB changed during this step (circuit should re-solve). */
  ioChanged: boolean;
}

export type ResetKind = 'por' | 'mclr' | 'wdt';

export interface CoreSnapshot {
  pc: number;
  w: number;
  status: number;
  /** All 256 file-register addresses as seen through the bank map (index = address, 0x00–0xFF). Unimplemented read as 0. */
  file: Uint8Array;
  stack: number[];      // bottom..top, length 0..8
  cycles: number;       // total instruction cycles since reset
  sleeping: boolean;
  halted: boolean;      // stuck in "goto $" at end of main or explicit halt
  eeprom: Uint8Array;   // 64 bytes
  tmr0Prescaler: number;
}

export interface PicCore extends McuPins {
  readonly clockHz: number;
  /** Instruction cycle time in seconds = 4 / clockHz. */
  readonly tcy: number;
  /** Load 1024 program words (14-bit), optional 64-byte EEPROM image, optional config word (default 0x3FFB). */
  load(program: Uint16Array, eeprom?: Uint8Array, config?: number): void;
  reset(kind?: ResetKind): void;
  /** Execute one instruction (or one cycle of sleep). */
  step(): StepResult;
  /** Execute until at least `cycles` instruction cycles elapsed, or a breakpoint hits. Returns cycles executed. */
  run(cycles: number, breakpoints?: ReadonlySet<number>): number;
  snapshot(): CoreSnapshot;
  /** Debugger access without side effects (no TMR0 write effects, no EEPROM sequence, etc.). Address 0x00–0xFF bank-mapped. */
  peek(addr: number): number;
  poke(addr: number, value: number): void;
  readonly pc: number;
  readonly w: number;
}
