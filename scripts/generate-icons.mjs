// Renders the MomExpress icon set from SVG. Run with `npm run icons` after
// changing the artwork; the PNGs are committed so builds don't need a browser.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// Playwright isn't a project dependency; use whichever install is available
// (e.g. `npm i -g playwright && npx playwright install chromium`).
const { chromium } = createRequire(import.meta.url)('playwright');

const outDir = path.resolve('web/public/icons');
fs.mkdirSync(outDir, { recursive: true });

const gradient = `
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#FF4F8B"/>
    <stop offset="0.55" stop-color="#FF7862"/>
    <stop offset="1" stop-color="#FFA845"/>
  </linearGradient>`;

const HEART = 'M256 416C256 416 96 320 96 208C96 152 140 112 192 112C224 112 248 130 256 152C264 130 288 112 320 112C372 112 416 152 416 208C416 320 256 416 256 416Z';

// A heart in a hurry: the heart plus three speed lines, centred on 256,256.
function motif(color, scale = 1) {
  return `
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)">
    <g transform="translate(24 -12)">
      <g fill="none" stroke="${color}" stroke-linecap="round" stroke-width="30">
        <path d="M84 222H150"/>
        <path d="M52 268H150"/>
        <path d="M108 314H178"/>
      </g>
      <g transform="translate(298 270) scale(0.66) translate(-256 -264)">
        <path fill="${color}" d="${HEART}"/>
      </g>
    </g>
  </g>`;
}

const svg = (body, size = 512) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}"><defs>${gradient}</defs>${body}</svg>`;

const shine = '<ellipse cx="150" cy="70" rx="300" ry="170" fill="#fff" opacity="0.10"/>';
const rounded = svg(`<rect width="512" height="512" rx="116" fill="url(#bg)"/><clipPath id="c"><rect width="512" height="512" rx="116"/></clipPath><g clip-path="url(#c)">${shine}</g>${motif('#fff')}`);
const fullBleed = (scale) => svg(`<rect width="512" height="512" fill="url(#bg)"/>${shine}${motif('#fff', scale)}`);
const badge = svg(motif('#fff', 1.12));

const targets = [
  { file: 'icon-192.png', size: 192, markup: rounded },
  { file: 'icon-512.png', size: 512, markup: rounded },
  { file: 'icon-maskable-512.png', size: 512, markup: fullBleed(0.74) },
  { file: 'apple-touch-icon.png', size: 180, markup: fullBleed(0.86) },
  { file: 'favicon-32.png', size: 32, markup: rounded },
  { file: 'badge-96.png', size: 96, markup: badge },
];

fs.writeFileSync(path.join(outDir, 'favicon.svg'), rounded.replace(/ width="512" height="512"/, ''));

const browser = await chromium.launch();
const page = await browser.newPage();
for (const { file, size, markup } of targets) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${markup.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)}</body></html>`,
  );
  await page.locator('svg').screenshot({ path: path.join(outDir, file), omitBackground: true });
  console.log(`wrote ${file}`);
}
await browser.close();
