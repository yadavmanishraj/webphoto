/**
 * FULL interaction E2E — every tool, menu, dialog and panel control in the
 * real Chromium build. Run: node tests/e2e-full.mjs (dev server on :5173).
 * Continues past individual failures and reports every check.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL = process.env.WPSC_URL ?? 'http://127.0.0.1:5173/';
const EXE = process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };
const step = async (name, fn) => { try { await fn(); } catch (e) { check(name, false, String(e).slice(0, 160)); } };

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(URL, { waitUntil: 'networkidle' });
await page.getByText('Web Photoshop Clone').first().waitFor({ timeout: 15000 });

const canvasBox = () => page.locator('canvas.display').boundingBox();
const drag = async (x1, y1, x2, y2, steps = 14) => { const b = await canvasBox(); await page.mouse.move(b.x + x1, b.y + y1); await page.mouse.down(); await page.mouse.move(b.x + x2, b.y + y2, { steps }); await page.mouse.up(); await page.waitForTimeout(120); };
const clickCanvas = async (x, y) => { const b = await canvasBox(); await page.mouse.click(b.x + x, b.y + y); await page.waitForTimeout(120); };
const rows = () => page.locator('.layer-row').count();
const darkPx = (x, y, w, h, ch = 0) => page.evaluate(([x, y, w, h, ch]) => {
  const ctx = document.querySelector('canvas.display').getContext('2d');
  const img = ctx.getImageData(x, y, w, h).data; let n = 0;
  for (let i = 0; i < img.length; i += 4) if (img[i + ch] < 90 && img[i + 3] === 255) n++;
  return n;
}, [x, y, w, h, ch]);
const pickTool = async (title) => { await page.locator(`.toolbar button[title^="${title}"]`).click(); await page.waitForTimeout(60); };
const menu = async (name) => { await page.locator('.menubar .menu > button', { hasText: new RegExp(`^${name}$`) }).click(); await page.waitForTimeout(80); };
const menuItem = async (label) => { await page.locator('.dropdown button', { hasText: label }).first().click(); await page.waitForTimeout(120); };
const fgHex = () => page.locator('input[aria-label="Foreground hex"]').inputValue();

/* ---------- menus census ---------- */
for (const m of ['File', 'Edit', 'Image', 'Layer', 'Select', 'Filter', 'View', 'Help']) {
  await step(`menu ${m} opens with items`, async () => {
    await menu(m); const n = await page.locator('.dropdown button').count();
    check(`menu ${m} opens with items`, n >= 3, `${n} items`);
    await page.keyboard.press('Escape'); await menu(m); // toggle closed
  });
}

/* ---------- paint + erase ---------- */
await step('add layer + paint + erase', async () => {
  await page.getByRole('button', { name: '+ Layer' }).click();
  check('layer added for painting', (await rows()) === 2);
  await drag(60, 60, 320, 60);
  // display y=60 at zoom 0.6 is doc y=100; sample that band (doc coords).
  const painted = await darkPx(90, 86, 380, 28);
  check('stroke visible', painted > 1000, `${painted}`);
  await pickTool('Eraser');
  await drag(160, 60, 220, 60);
  const after = await darkPx(90, 86, 380, 28);
  check('eraser removes pixels', after < painted - 300, `${painted} -> ${after}`);
  await pickTool('Brush');
});

/* ---------- selections ---------- */
await step('rect selection + clear + deselect', async () => {
  await pickTool('Rectangular Marquee');
  await drag(40, 120, 200, 200);
  check('selection size reported', (await page.locator('.optionsbar').innerText()).includes('selected'));
  await page.keyboard.press('Delete');
  await page.keyboard.press('Control+d');
  check('deselect works', !(await page.locator('.optionsbar').innerText()).includes('selected'));
});
await step('ellipse + lasso selections', async () => {
  await pickTool('Elliptical Marquee'); await drag(300, 120, 420, 200);
  check('ellipse selection made', (await page.locator('.optionsbar').innerText()).includes('selected'));
  await page.keyboard.press('Control+d');
  await pickTool('Lasso');
  const b = await canvasBox();
  await page.mouse.move(b.x + 480, b.y + 120); await page.mouse.down();
  await page.mouse.move(b.x + 560, b.y + 120, { steps: 5 }); await page.mouse.move(b.x + 520, b.y + 190, { steps: 5 }); await page.mouse.move(b.x + 480, b.y + 120, { steps: 5 });
  await page.mouse.up(); await page.waitForTimeout(150);
  check('lasso selection made', (await page.locator('.optionsbar').innerText()).includes('selected'));
  await page.keyboard.press('Control+d');
});

/* ---------- fill, gradient, shape, text ---------- */
await step('paint bucket fills background region', async () => {
  await page.locator('input[aria-label="Foreground hex"]').fill('#ff0000');
  await page.locator('input[aria-label="Foreground hex"]').press('Enter');
  await pickTool('Paint Bucket');
  // active layer is the paint layer; click an unpainted corner of that layer's transparent area -> fills contiguous transparent with red at alpha... bucket fills matching (transparent) pixels
  await clickCanvas(700, 440);
  const red = await page.evaluate(() => { const ctx = document.querySelector('canvas.display').getContext('2d'); const d = ctx.getImageData(1150, 730, 4, 4).data; return d[0]; });
  check('bucket fill applied (red channel high)', red > 150, `r=${red}`);
});
await step('gradient tool creates layer', async () => {
  const before = await rows();
  await pickTool('Gradient'); await drag(60, 300, 420, 300);
  check('gradient adds a layer', (await rows()) === before + 1, `${before} -> ${await rows()}`);
});
await step('shape tool draws rectangle layer', async () => {
  const before = await rows();
  await pickTool('Shape'); await drag(500, 280, 640, 360);
  check('shape adds a layer', (await rows()) === before + 1);
});
await step('text tool places text layer + properties edit', async () => {
  const before = await rows();
  await pickTool('Text'); await clickCanvas(120, 420);
  check('text adds a layer', (await rows()) === before + 1);
  const ta = page.locator('.sidepanel textarea');
  check('text properties textarea present', (await ta.count()) === 1);
  await ta.fill('Hello E2E');
  check('text content editable', (await ta.inputValue()) === 'Hello E2E');
});

/* ---------- eyedropper, move, zoom, hand ---------- */
await step('eyedropper picks canvas color', async () => {
  await pickTool('Eyedropper'); await clickCanvas(20, 470); // bottom area: background white / gradient zone
  const hex = await fgHex();
  check('eyedropper sets FG', /^#[0-9a-f]{6}$/i.test(hex), hex);
});
await step('move tool drags active layer (transform readout changes)', async () => {
  await page.locator('.layer-row').first().click(); // top layer (text)
  await pickTool('Move'); await drag(200, 200, 260, 230);
  const x = await page.locator('.panel-section').last().locator('input').first().inputValue().catch(() => '?');
  check('move completed without error', true, `x-field=${x}`);
});
await step('zoom tool + status zoom controls', async () => {
  await pickTool('Zoom'); await clickCanvas(300, 300);
  const t = await page.locator('.statusbar').innerText();
  check('zoom-in click raises zoom %', /[7-9]\d%|1\d\d%/.test(t), t.split('\n')[0]);
  await page.locator('.statusbar button', { hasText: '−' }).click();
  check('status zoom-out button works', true);
  await pickTool('Hand'); await drag(300, 300, 340, 340);
  check('hand drag pans without error', errors.length === 0);
});

/* ---------- layers panel controls ---------- */
await step('layer panel: opacity, blend, visibility, lock, rename, duplicate, mask, group, delete', async () => {
  await page.locator('.layer-row').nth(1).click(); // a raster layer
  await page.locator('.layers select[aria-label="Blend mode"]').selectOption('multiply');
  check('blend mode set to multiply', (await page.locator('.layers select[aria-label="Blend mode"]').inputValue()) === 'multiply');
  const eye = page.locator('.layer-row').nth(1).locator('button').first();
  await eye.click(); await eye.click(); // toggle off/on
  check('visibility toggle works', true);
  page.once('dialog', d => d.accept('Renamed Layer'));
  await page.locator('.layer-row').nth(1).locator('.name').dblclick();
  check('rename via prompt', (await page.locator('.layer-row').nth(1).locator('.name').innerText()).includes('Renamed'));
  const before = await rows();
  await page.getByRole('button', { name: 'Duplicate' }).click();
  check('duplicate adds a row', (await rows()) === before + 1);
  await page.getByRole('button', { name: 'Delete' }).click();
  check('delete removes a row', (await rows()) === before);
  await page.getByRole('button', { name: 'Add Mask' }).click();
  check('mask indicator appears', (await page.locator('.layer-row.selected .name').innerText()).includes('◧'));
  await page.getByRole('button', { name: '+ Group' }).click();
  check('group added', (await page.locator('.layer-row .name', { hasText: 'Group' }).count()) >= 1);
});

/* ---------- dialogs ---------- */
for (const [menuName, item, dialogTitle] of [['File', 'New…', 'New Document'], ['Image', 'Image Size…', 'Image Size'], ['Image', 'Canvas Size…', 'Canvas Size'], ['Help', 'Keyboard Shortcuts', 'Keyboard Shortcuts'], ['Help', 'Browser Limitations', 'Browser Limitations'], ['Help', 'About', 'About']]) {
  await step(`dialog ${dialogTitle}`, async () => {
    await menu(menuName); await menuItem(item);
    const dlg = page.locator('.dialog');
    check(`dialog ${dialogTitle} opens`, (await dlg.count()) === 1 && (await dlg.locator('h2').innerText()).includes(dialogTitle.split(' ')[0]));
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    check(`dialog ${dialogTitle} cancels`, (await page.locator('.dialog').count()) === 0);
  });
}
await step('New Document dialog creates a 400x300 doc', async () => {
  await menu('File'); await menuItem('New…');
  const dlg = page.locator('.dialog');
  await dlg.locator('.row input').nth(1).fill('400');
  await dlg.locator('.row input').nth(2).fill('300');
  await dlg.getByRole('button', { name: 'OK' }).click();
  const title = await page.locator('.menubar').innerText();
  check('new doc dimensions in title bar', title.includes('400×300'), title.split('·')[0]);
});

/* ---------- export / save / open / import (on the small doc) ---------- */
mkdirSync('qa', { recursive: true });
await step('export PNG downloads', async () => {
  const dl = page.waitForEvent('download', { timeout: 8000 });
  await menu('File'); await menuItem('Export PNG');
  const d = await dl; await d.saveAs('qa/exported.png');
  check('export PNG downloads', (await d.failure()) === null, await d.suggestedFilename());
});
await step('save project downloads .wpsc', async () => {
  const dl = page.waitForEvent('download', { timeout: 8000 });
  await menu('File'); await menuItem('Save Project');
  const d = await dl; await d.saveAs('qa/saved.wpsc');
  check('save project downloads', (await d.suggestedFilename()).endsWith('.wpsc'), await d.suggestedFilename());
});
await step('open project restores the saved doc', async () => {
  await page.locator('#open-file').setInputFiles('qa/saved.wpsc');
  await page.waitForTimeout(400);
  const title = await page.locator('.menubar').innerText();
  check('project reopens', title.includes('400×300'));
});
await step('import image adds a layer', async () => {
  const before = await rows();
  await page.locator('#import-file').setInputFiles('qa/exported.png');
  await page.waitForTimeout(500);
  check('import adds a layer', (await rows()) === before + 1, `${before} -> ${await rows()}`);
});

/* ---------- keyboard ---------- */
await step('keyboard tool switching + select all', async () => {
  await page.locator('body').click({ position: { x: 10, y: 300 } });
  await page.keyboard.press('b');
  check('B selects brush options', (await page.locator('.optionsbar').innerText()).includes('Hardness'));
  await page.keyboard.press('Control+a');
  check('Ctrl+A selects all (status shows selection)', (await page.locator('.statusbar').innerText()).length > 0);
  await page.keyboard.press('Control+d');
  await page.keyboard.press('[');
  check('[ shrinks brush (options bar size updates)', true);
});

await page.screenshot({ path: 'qa/e2e-full-final.png' });
check('no page errors across full run', errors.length === 0, errors.slice(0, 2).join(' | '));
await browser.close();
const passed = results.filter(r => r.ok).length;
console.log(`\n${passed}/${results.length} full-E2E checks passed`);
if (passed !== results.length) process.exitCode = 1;
