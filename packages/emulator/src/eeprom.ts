// 64-byte data EEPROM with its EECON1/EECON2 control logic (DS35007, section 3).
import { EECON1_EEIF, EECON1_RD, EECON1_WR, EECON1_WREN, EECON1_WRERR, EEPROM_BYTES } from './sfr';

/** Proteus PIC16 model property EPR_WRITEDATA_DELAY=10m (the datasheet gives 4 ms typical, 10 ms max). */
export const EEPROM_WRITE_TIME_S = 0.01;

/** Erased EEPROM content (Proteus MODDATA=64,255). */
export const EEPROM_ERASED = 0xff;

/** EECON2 unlock sequence state. */
const Unlock = { Locked: 0, Got55: 1, Armed: 2 } as const;
type UnlockState = (typeof Unlock)[keyof typeof Unlock];

const SOFTWARE_BITS = EECON1_EEIF | EECON1_WRERR | EECON1_WREN;

export class DataEeprom {
  readonly data = new Uint8Array(EEPROM_BYTES).fill(EEPROM_ERASED);
  eedata = 0;
  eeadr = 0;
  /** EECON1 bits 4..0 (bits 7..5 unimplemented). */
  eecon1 = 0;
  /** Absolute cycle at which the write in progress completes; Infinity when idle. */
  writeDoneAt = Infinity;
  private unlock: UnlockState = Unlock.Locked;
  private pendingAddr = 0;
  private pendingData = 0;

  get writing(): boolean {
    return this.writeDoneAt !== Infinity;
  }

  /** EECON2 is not a physical register: it only feeds the 55h / AAh unlock sequence. */
  writeEecon2(value: number): void {
    if (value === 0x55) this.unlock = Unlock.Got55;
    else if (value === 0xaa && this.unlock === Unlock.Got55) this.unlock = Unlock.Armed;
    else this.unlock = Unlock.Locked;
  }

  /**
   * Program write to EECON1. RD and WR can only be set by software (hardware clears them).
   * RD copies EE[EEADR] into EEDATA immediately; WR starts a write only when WREN = 1 and the
   * 55h/AAh sequence was written to EECON2 just before.
   */
  writeEecon1(value: number, now: number, writeCycles: number): void {
    this.eecon1 = (value & SOFTWARE_BITS) | (this.eecon1 & EECON1_WR);
    if (value & EECON1_RD) this.eedata = this.data[this.eeadr & (EEPROM_BYTES - 1)];
    if (value & EECON1_WR && !this.writing) {
      if (this.eecon1 & EECON1_WREN && this.unlock === Unlock.Armed) {
        this.eecon1 |= EECON1_WR;
        this.pendingAddr = this.eeadr & (EEPROM_BYTES - 1);
        this.pendingData = this.eedata;
        this.writeDoneAt = now + writeCycles;
      }
      this.unlock = Unlock.Locked;
    }
  }

  /** End of the write cycle: store the byte, clear WR, set EEIF. */
  completeWrite(): void {
    this.data[this.pendingAddr] = this.pendingData;
    this.eecon1 = (this.eecon1 & ~EECON1_WR) | EECON1_EEIF;
    this.writeDoneAt = Infinity;
  }

  /** Reset of the control registers; on an MCLR or WDT reset a write in progress is aborted and flagged in WRERR. */
  resetControl(powerOn: boolean): void {
    const aborted = this.writing;
    this.writeDoneAt = Infinity;
    this.unlock = Unlock.Locked;
    if (powerOn) {
      this.eecon1 = 0;
      this.eedata = 0;
      this.eeadr = 0;
    } else {
      this.eecon1 = aborted ? EECON1_WRERR : this.eecon1 & EECON1_WRERR;
    }
  }
}
