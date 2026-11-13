#!/usr/bin/env node
// Packages the Mac app: dist-app/PIC Studio-darwin-<arch>/PIC Studio.app, ad-hoc signed.
// Run through `npm run package` (which first runs `npm run app:build`: Vite renderer + Electron bundles).
//   - @electron/packager with the Electron zip already in the local cache (no download), asar, our icon,
//     French document types (.picproj, .c, .DSN), bundle id com.picstudio.app;
//   - only out/electron/, app/dist/ and package.json go into app.asar (everything is bundled, no node_modules);
//   - French-only bundle localisation, so the native dialogs speak French on any Mac;
//   - codesign --force --deep -s - (ad-hoc), then codesign --verify.
import { defaultSanitizePackageJson, packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist-app');
const APP_NAME = 'PIC Studio';
const BUNDLE_ID = 'com.picstudio.app';
const APP_VERSION = process.env.PIC_STUDIO_VERSION?.trim() || '1.0.0';
const arch = process.env.PIC_STUDIO_ARCH?.trim() || (process.arch === 'x64' ? 'x64' : 'arm64');

const electronVersion = JSON.parse(readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;

function fail(message) {
  console.error(`[package] ${message}`);
  process.exit(1);
}

// ------------------------------------------------------------------------------------------------ inputs

for (const file of ['out/electron/main.cjs', 'out/electron/preload.cjs', 'app/dist/index.html']) {
  if (!existsSync(path.join(root, file))) fail(`${file} manquant : lancez d’abord « npm run app:build ».`);
}
const icon = path.join(root, 'build', 'icon.icns');
if (!existsSync(icon)) {
  console.log('[package] build/icon.icns manquant : génération depuis build/icon.svg');
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build-icon.mjs')], { stdio: 'inherit' });
}

/** The Electron zip that `npm install` already downloaded (so packaging works offline). */
function cachedElectronZipDir() {
  const zipName = `electron-v${electronVersion}-darwin-${arch}.zip`;
  const caches = [
    process.env.electron_config_cache,
    process.env.ELECTRON_CACHE,
    path.join(homedir(), 'Library', 'Caches', 'electron'),
  ].filter(Boolean);
  for (const cache of caches) {
    if (!existsSync(cache)) continue;
    if (existsSync(path.join(cache, zipName))) return cache;
    for (const entry of readdirSync(cache)) {
      const dir = path.join(cache, entry);
      if (existsSync(path.join(dir, zipName))) return dir;
    }
  }
  return undefined;
}

/** Build number: commits on the current branch, else the date (CFBundleVersion must be numeric). */
function buildNumber() {
  try {
    return execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return new Date().toISOString().slice(0, 10).replace(/-/g, '');
  }
}

/** app.asar keeps only these (paths relative to the repo root, as packager passes them: '/out/electron/main.cjs'). */
const KEEP = ['/package.json', '/out/electron', '/app/dist'];
const ignore = (file) => {
  if (file === '') return false;
  return !KEEP.some((keep) => file === keep || file.startsWith(`${keep}/`) || keep.startsWith(`${file}/`));
};

// ------------------------------------------------------------------------------------------------ packager

const electronZipDir = cachedElectronZipDir();
console.log(`[package] Electron ${electronVersion} darwin-${arch}${electronZipDir ? ` (zip en cache : ${electronZipDir})` : ' (téléchargement)'}`);

const started = Date.now();
const [appDir] = await packager({
  dir: root,
  out: outDir,
  overwrite: true,
  platform: 'darwin',
  arch,
  electronVersion,
  ...(electronZipDir ? { electronZipDir } : {}),
  name: APP_NAME,
  executableName: APP_NAME,
  appBundleId: BUNDLE_ID,
  appVersion: APP_VERSION,
  buildVersion: buildNumber(),
  appCategoryType: 'public.app-category.education',
  appCopyright: 'PIC Studio — PIC16F84A : schéma, code C, assembleur et organigramme.',
  darwinDarkModeSupport: true,
  icon,
  asar: true,
  prune: false,
  junk: true,
  derefSymlinks: true,
  ignore,
  quiet: true,
  sanitizePackageJson: [
    defaultSanitizePackageJson,
    (pkg) => ({
      ...pkg,
      name: 'pic-studio',
      productName: APP_NAME,
      version: APP_VERSION,
      description: 'Schéma, code C, assembleur et organigramme pour le PIC16F84A',
      main: 'out/electron/main.cjs',
    }),
  ],
  extendInfo: {
    CFBundleDisplayName: APP_NAME,
    CFBundleDevelopmentRegion: 'fr',
    CFBundleLocalizations: ['fr'],
    LSApplicationCategoryType: 'public.app-category.education',
    NSHumanReadableCopyright: 'PIC Studio — PIC16F84A : schéma, code C, assembleur et organigramme.',
    CFBundleDocumentTypes: [
      {
        CFBundleTypeName: 'Projet PIC Studio',
        CFBundleTypeRole: 'Editor',
        LSHandlerRank: 'Owner',
        LSItemContentTypes: ['com.picstudio.project'],
      },
      {
        CFBundleTypeName: 'Programme C (MikroC)',
        CFBundleTypeRole: 'Editor',
        LSHandlerRank: 'Alternate',
        LSItemContentTypes: ['public.c-source'],
      },
      {
        CFBundleTypeName: 'Schéma Proteus ISIS',
        CFBundleTypeRole: 'Viewer',
        LSHandlerRank: 'Default',
        LSItemContentTypes: ['com.labcenter.proteus.dsn'],
      },
    ],
    UTExportedTypeDeclarations: [
      {
        UTTypeIdentifier: 'com.picstudio.project',
        UTTypeDescription: 'Projet PIC Studio',
        UTTypeConformsTo: ['public.json', 'public.data'],
        UTTypeTagSpecification: { 'public.filename-extension': ['picproj'], 'public.mime-type': ['application/x-picstudio-project'] },
      },
    ],
    UTImportedTypeDeclarations: [
      {
        UTTypeIdentifier: 'com.labcenter.proteus.dsn',
        UTTypeDescription: 'Schéma Proteus ISIS',
        UTTypeConformsTo: ['public.data'],
        UTTypeTagSpecification: { 'public.filename-extension': ['dsn', 'DSN'] },
      },
    ],
  },
});
if (!appDir) fail('@electron/packager n’a rien produit.');
const appPath = path.join(appDir, `${APP_NAME}.app`);
if (!existsSync(appPath)) fail(`${appPath} introuvable après le packaging.`);

// ------------------------------------------------------------------------------------------------ French only

// macOS picks the language of the native panels (Annuler / Enregistrer…) from the bundle's localisations:
// keep French only, so they match the rest of the app whatever the Mac's language.
const resources = path.join(appPath, 'Contents', 'Resources');
for (const entry of readdirSync(resources)) {
  if (entry.endsWith('.lproj') && entry !== 'fr.lproj') rmSync(path.join(resources, entry), { recursive: true, force: true });
}

// ------------------------------------------------------------------------------------------------ signing

execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' });

// ------------------------------------------------------------------------------------------------ report

const duKb = (p) => Number(execFileSync('du', ['-sk', p], { encoding: 'utf8' }).split('\t')[0]);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
const fileSize = (p) => (existsSync(p) ? statSync(p).size : 0);
const asar = path.join(resources, 'app.asar');
const bundles = ['main.cjs', 'preload.cjs'].map((f) => `${f} ${(fileSize(path.join(root, 'out', 'electron', f)) / 1024).toFixed(1)} ko`);
console.log(`[package] ${path.relative(root, appPath)} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
console.log(`[package]   app : ${mb(duKb(appPath) * 1024)} · app.asar : ${mb(fileSize(asar))} · renderer (app/dist) : ${mb(duKb(path.join(root, 'app', 'dist')) * 1024)}`);
console.log(`[package]   bundles Electron : ${bundles.join(' · ')}`);
console.log(`[package]   signature ad hoc vérifiée (codesign --verify --deep --strict)`);
