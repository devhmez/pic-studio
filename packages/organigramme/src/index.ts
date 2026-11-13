// @pic/organigramme: Program → organigramme in the prof's style (or classic black & white), as a placed Diagram
// and as a standalone SVG. Deterministic and DOM-free: runs the same in Node tests and in the browser.
export * from './types';
export { layout, layoutFunction, topPort, bottomPort, rightPort } from './layout';
export { renderSvg } from './svg';
export { renderProgramCharts, MAIN_CHART_TITLE } from './charts';
export { FONTS, METRICS, PALETTES, type FontSpec, type Palette, type BoxPaint } from './theme';
export { textWidth, wrapText, type MetricsFace } from './text';
