// Renders design/icon.svg to the app's PNG icons (web and Android) with the bundled Chromium.
// Run: node scripts/make-icons.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const svg = readFileSync(new URL('../design/icon.svg', import.meta.url), 'utf8');
const targets = [
  ['public/icons/icon-192.png', 192, 0.22], ['public/icons/icon-512.png', 512, 0.22], ['public/icons/maskable-512.png', 512, 0],
  ['public/icons/apple-touch-icon.png', 180, 0], ['public/icons/badge-96.png', 96, 0.22],
  ['android/app/src/main/res/mipmap-mdpi/ic_launcher.png', 48, 0.22], ['android/app/src/main/res/mipmap-hdpi/ic_launcher.png', 72, 0.22],
  ['android/app/src/main/res/mipmap-xhdpi/ic_launcher.png', 96, 0.22], ['android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png', 144, 0.22],
  ['android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', 192, 0.22],
];
// Playwright comes with the build machine's browser; it isn't an app dependency.
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [path, size, round] of targets) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px;border-radius:${round * size}px;overflow:hidden">${svg.replace('<svg', `<svg width="${size}" height="${size}"`)}</div></body></html>`);
  mkdirSync(path.replace(/\/[^/]+$/, ''), { recursive: true });
  writeFileSync(path, await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
}
// Android notification icon: a white silhouette of Carino.
const silhouette = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="96" height="96"><g fill="#fff"><path d="M61 14 C66 4 80 4 84 9 C78 16 68 18 61 14 Z"/><path d="M60 18 C55 10 44 10 41 14 C46 20 54 21 60 18 Z"/><rect x="58" y="12" width="4" height="18" rx="2"/><path d="M60 26 C88 26 106 44 106 70 C106 94 86 110 60 110 C34 110 14 94 14 70 C14 44 32 26 60 26 Z"/></g></svg>';
await page.setViewportSize({ width: 96, height: 96 });
await page.setContent(`<html><body style="margin:0;background:transparent">${silhouette}</body></html>`);
writeFileSync('android/app/src/main/res/drawable/ic_notification.png', await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: 96, height: 96 } }));
await browser.close();
writeFileSync('public/icons/favicon.svg', svg);
console.log('Icons written');
