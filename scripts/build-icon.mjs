#!/usr/bin/env node
// build/icon.svg → build/icon.icns (macOS app icon) + build/icon.png (1024 px, Dock icon of `npm run app:dev`).
// The SVG is drawn by Electron's Chromium (scripts/render-icon.cjs) at each iconset size, then iconutil packs them.
// Usage: node scripts/build-icon.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron');
const svg = path.join(root, 'build', 'icon.svg');
const work = mkdtempSync(path.join(tmpdir(), 'pic-studio-icon-'));

try {
  const json = path.join(work, 'pngs.json');
  execFileSync(electron, [path.join(root, 'scripts', 'render-icon.cjs'), svg, json], { stdio: ['ignore', 'inherit', 'inherit'] });
  /** @type {Record<string, string>} */
  const pngs = JSON.parse(readFileSync(json, 'utf8'));
  const png = (size) => {
    const data = pngs[String(size)];
    if (!data) throw new Error(`Taille ${size} px manquante dans le rendu de l’icône.`);
    return Buffer.from(data, 'base64');
  };

  const iconset = path.join(work, 'icon.iconset');
  execFileSync('mkdir', ['-p', iconset]);
  for (const size of [16, 32, 128, 256, 512]) {
    writeFileSync(path.join(iconset, `icon_${size}x${size}.png`), png(size));
    writeFileSync(path.join(iconset, `icon_${size}x${size}@2x.png`), png(size * 2));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(root, 'build', 'icon.icns')]);
  writeFileSync(path.join(root, 'build', 'icon.png'), png(1024));
  console.log('[build-icon] build/icon.icns + build/icon.png');
} finally {
  rmSync(work, { recursive: true, force: true });
}
