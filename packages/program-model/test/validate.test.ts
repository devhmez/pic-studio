/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSchematicJson, type Schematic } from '@pic/circuit';
import { blocks as b, cloneProgram, emptyProgram, ensureIds, parseProgramJson, validate, type Program, type Signal } from '../src';

const read = (file: string) => readFileSync(new URL(`../../../templates/${file}`, import.meta.url), 'utf8');
const template = (id: string): Program => parseProgramJson(read(`${id}.program.json`));
const schematic = (id: string): Schematic => parseSchematicJson(read(`${id}.schematic.json`));

const codes = (p: Program, s?: Schematic) => validate(p, s).map((i) => i.code);

const sig = (name: string, pin: Signal['pin'], dir: Signal['dir'], extra: Partial<Signal> = {}): Signal =>
  ({ id: name.toLowerCase(), name, pin, dir, label: name, activeLevel: 1, device: dir === 'out' ? 'led' : 'logicstate', ...extra });

const make = (p: Partial<Program>): Program => ensureIds({ ...emptyProgram(), ...p });

describe('validate', () => {
  it('accepts every template, with and without its schematic', () => {
    for (const id of ['tp0-exemple1', 'tp0-exemple2', 'tp1-demux', 'tp-status', 'tp-vote', 'tp-traffic', 'tp-pupitre', 'tp5-int-rb0', 'tp6-rbie']) {
      expect(validate(template(id)), id).toEqual([]);
      expect(validate(template(id), schematic(id)), id).toEqual([]);
    }
  });

  it('an input written as an output, unknown references, bad names and duplicate pins', () => {
    const p = make({
      signals: [sig('BP', 'RA0', 'in'), sig('LED', 'RA0', 'out'), sig('led', 'RB1', 'out'), sig('2X', 'RB2', 'out'), sig('PORTB', 'RB3', 'out')],
      init: [b.on('bp'), b.on('nope'), b.incr('compteur'), b.delay(0), b.call('absente')],
      loop: [b.when(b.pin('led', 1), [b.display('aff', 3)])],
    });
    const found = validate(p);
    expect(found.map((i) => i.code)).toEqual([
      'E_PIN_TWICE', 'E_DUPLICATE_ID', 'E_DUPLICATE_NAME', 'E_BAD_NAME', 'E_RESERVED_NAME',
      'E_INPUT_WRITTEN', 'E_UNKNOWN_SIGNAL', 'E_UNKNOWN_VARIABLE', 'E_BAD_DELAY', 'E_UNKNOWN_FUNCTION',
      'W_OUTPUT_TESTED', 'E_UNKNOWN_BUS',
    ]);
    const input = found.find((i) => i.code === 'E_INPUT_WRITTEN')!;
    expect(input.message).toBe("BP (RA0) est une entrée : on ne peut pas l'allumer ou l'éteindre. Changez sa direction ou choisissez une sortie.");
    expect(input.stmtId).toBe(p.init[0].id);
  });

  it('RA4 open drain, buses beyond the port, values too wide for the bus', () => {
    const p = make({
      signals: [sig('LED', 'RA4', 'out')],
      buses: [{ id: 'aff', name: 'AFF', port: 'B', lsb: 0, width: 4, dir: 'out', label: 'Afficheur', device: 'bcd' },
        { id: 'big', name: 'BIG', port: 'A', lsb: 2, width: 4, dir: 'out', label: 'Trop large' }],
      loop: [b.display('aff', 0x1f)],
    });
    expect(codes(p)).toEqual(['W_RA4_OPEN_DRAIN', 'E_BAD_BUS', 'W_VALUE_TOO_WIDE']);
  });

  it('interrupts: routine missing or never called, flag never cleared, GIE off, RB0 output', () => {
    const p = template('tp5-int-rb0');
    const noIsr = cloneProgram(p);
    noIsr.functions = [];
    expect(codes(noIsr)).toEqual(['E_NO_ISR']);

    const noClear = cloneProgram(p);
    const chain = noClear.functions[0].body[0];
    if (chain.kind !== 'if') throw new Error();
    chain.branches[0].body = chain.branches[0].body.filter((s) => s.kind !== 'clearFlag');
    expect(validate(noClear).map((i) => [i.code, i.message])).toEqual([
      ['W_FLAG_NOT_CLEARED', "Le drapeau INTF (RB0/INT) n'est jamais remis à 0 dans l'interruption : elle se redéclenchera sans fin."],
    ]);

    const noGie = cloneProgram(p);
    noGie.interrupts = { ...noGie.interrupts!, gie: false };
    expect(codes(noGie)).toEqual(['W_NO_GIE']);

    const notEnabled = cloneProgram(p);
    delete notEnabled.interrupts;
    expect(codes(notEnabled)).toEqual(['W_ISR_NEVER_CALLED']);

    const rb0Out = cloneProgram(p);
    rb0Out.signals[0] = { ...rb0Out.signals[0], dir: 'out', device: 'led' };
    expect(codes(rb0Out)).toContain('E_INT_PIN_OUTPUT');

    const rbie = cloneProgram(template('tp6-rbie'));
    rbie.signals = rbie.signals.filter((s) => s.dir === 'out');
    expect(codes(rbie)).toContain('W_RBIE_NO_INPUT');
  });

  it('against the schematic: unconnected pins, output on a switch, input on a LED, clock and component mismatch', () => {
    const p = template('tp-status');
    p.signals.push(sig('LIBRE', 'RB7', 'out'));
    p.signals[0] = { ...p.signals[0], componentId: 'D99' };
    p.clockHz = 4_000_000;
    expect(codes(p, schematic('tp-status'))).toEqual(['W_CLOCK_MISMATCH', 'W_COMPONENT_MISSING', 'W_PIN_UNCONNECTED']);

    const q = template('tp1-demux');
    q.signals[0] = { ...q.signals[0], dir: 'out', device: 'led' }; // L0 is a LOGICSTATE
    q.signals[2] = { ...q.signals[2], dir: 'in', device: 'input' }; // D0 drives a LED
    const found = validate(q, schematic('tp1-demux'));
    expect(found.map((i) => i.code)).toEqual(expect.arrayContaining(['E_OUTPUT_ON_SOURCE', 'W_INPUT_ON_LOAD']));
    expect(found.find((i) => i.code === 'E_OUTPUT_ON_SOURCE')!.message).toBe(
      'L0 est une sortie, mais RA0 est reliée à un interrupteur (LOGICSTATE) : deux sources en conflit.',
    );
  });
});
