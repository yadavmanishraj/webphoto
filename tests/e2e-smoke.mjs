/**
 * Real-browser E2E smoke (§50 Test A/B) using playwright-core + the locally
 * installed Chromium headless shell. Run: node tests/e2e-smoke.mjs
 * Requires the dev server on :5173 (or set WPSC_URL).
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const URL = process.env.WPSC_URL ?? 'http://127.0.0.1:5173/';
const EXE = process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!ok) process.exitCode = 1; };

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.getByText('Web Photoshop Clone').first().waitFor({ timeout: 15000 });
check('app boots: menubar + title', true);
for (const m of ['File', 'Edit', 'Image', 'Layer', 'Select', 'Filter', 'View', 'Help'])
  check(`menu ${m}`, await page.locator('.menubar .menu > button', { hasText: new RegExp(`^${m}$`) }).count() === 1);
check('toolbar renders tools', (await page.locator('.toolbar button').count()) >= 14);
check('canvas present', await page.locator('canvas.display').count() === 1);
const layerRows = () => page.locator('.layer-row').count();
check('starts with Background layer', (await layerRows()) === 1, `rows=${await layerRows()}`);

const sampleStrokeRegion = () => page.evaluate(() => {
  const cv = document.querySelector('canvas.display');
  const ctx = cv.getContext('2d');
  // Stroke is drawn at display (130..340, 110); at zoom 0.6 that is doc
  // coords x 216..566, y ~183. Sample exactly that band.
  const img = ctx.getImageData(210, 165, 360, 40).data;
  let dark = 0;
  for (let i = 0; i < img.length; i += 4) if (img[i] < 80 && img[i + 1] < 80 && img[i + 2] < 80 && img[i + 3] === 255) dark++;
  return dark;
});

// Add a layer (Background is locked) and paint a stroke across the sample region.
await page.getByRole('button', { name: '+ Layer' }).click();
check('layer added', (await layerRows()) === 2);
const box = await page.locator('canvas.display').boundingBox();
await page.mouse.move(box.x + 130, box.y + 110);
await page.mouse.down();
await page.mouse.move(box.x + 340, box.y + 110, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(300);
const painted = await sampleStrokeRegion();
check('brush stroke paints dark pixels', painted > 200, `darkPx=${painted}`);
check('stroke is solid, not beaded (mouse pressure normalized)', painted > 1200, `darkPx=${painted}`);

// Undo removes the stroke; redo restores it.
await page.keyboard.press('Control+z');
await page.waitForTimeout(300);
const afterUndo = await sampleStrokeRegion();
check('Ctrl+Z undoes the stroke', afterUndo < painted * 0.25, `darkPx=${afterUndo}`);
await page.keyboard.press('Control+Shift+z');
await page.waitForTimeout(300);
const afterRedo = await sampleStrokeRegion();
check('Ctrl+Shift+Z redoes the stroke', afterRedo > painted * 0.6, `darkPx=${afterRedo}`);

// Second layer + menus.
await page.getByRole('button', { name: '+ Layer' }).click();
check('second layer added', (await layerRows()) === 3);
await page.locator('.menubar .menu > button', { hasText: /^Layer$/ }).click();
check('Layer menu opens with items', (await page.locator('.dropdown button').count()) >= 8);
await page.locator('.menubar .menu > button', { hasText: /^Filter$/ }).click();
check('Filter menu lists filters', (await page.locator('.dropdown button').count()) >= 10);
await page.keyboard.press('Escape');

mkdirSync('qa', { recursive: true });
await page.screenshot({ path: 'qa/e2e-final.png' });
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
console.log(`\n${results.filter(r => r.ok).length}/${results.length} E2E checks passed`);
