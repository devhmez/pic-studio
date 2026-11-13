// @pic/style-c: Program model → C source in the prof's MikroC style, and MikroC file export.
export { generate, generateWithMap, globalVariables, interruptLines, trisMode, trisValue, usesLedMacros } from './generate';
export type { GenerateOptions, GenerateResult, SourceMap } from './generate';
export { condC, exprC, numberLiteral, portBit, signalRef, trisBit, FLAG_C } from './format';
export { toMikroCFile } from './export';
