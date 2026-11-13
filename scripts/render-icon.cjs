// Electron main script used by scripts/build-icon.mjs: draws build/icon.svg on a canvas at every size of a macOS
// iconset (vector → each size directly, no resampling) and prints them as JSON { size: base64 PNG } on stdout.
// Usage: electron scripts/render-icon.cjs <icon.svg> <out.json>
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');

const [svgPath, outPath] = process.argv.slice(-2);
const SIZES = [16, 32, 64, 128, 256, 512, 1024];

app.dock?.hide();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const svg = readFileSync(svgPath);
  const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL('about:blank');
  const dataUrl = `data:image/svg+xml;base64,${svg.toString('base64')}`;
  const pngs = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(dataUrl)};
    await img.decode();
    const out = {};
    for (const size of ${JSON.stringify(SIZES)}) {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, size, size);
      out[size] = canvas.toDataURL('image/png').split(',')[1];
    }
    return out;
  })()`);
  writeFileSync(outPath, JSON.stringify(pngs));
  win.destroy();
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
