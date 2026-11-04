// Run against `bun dev`; set PLAYWRIGHT_MODULE if Playwright is outside node_modules.
import assert from 'node:assert/strict';
const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.BROWSER_ENGINE || 'chromium';
const browser = await playwright[engine].launch({ headless: true, executablePath: process.env.BROWSER_PATH || (engine === 'chromium' ? process.env.CHROME_PATH : undefined) });
const page = await browser.newPage({ viewport: { width: 1300, height: 850 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
const wait = async fn => { await page.waitForFunction(fn); };
const word = index => page.locator(`.wave-transcript-editor [data-word-id="w${index}"]`);
const snapshot = () => page.evaluate(() => window.editorApi().editingState());
try {
  await page.goto('http://localhost:1420/tests/fixtures/editor.html');
  await wait(() => window.editorApi?.()?.editingState().ready);
  // Pause creation, editing and persistence must match in text and waveform.
  const originalHeight = await page.locator('.wave-waveform-wrapper').evaluate(el => el.getBoundingClientRect().height);
  await word(5).click();
  assert.equal(await page.locator('.wave-waveform-wrapper').evaluate(el => el.getBoundingClientRect().height), originalHeight);
  assert.equal(await page.locator('.wave-waveform-toolbar .wave-selection-controls').count(), 1);
  // Live duration/unit changes and Words → Exact audio must not shift any field.
  await wait(() => !document.querySelector('[aria-label="Loop selection"]').disabled);
  const readoutGeometry = () => page.locator('.wave-selection-controls').evaluate(el =>
    [el, ...el.querySelectorAll('input, .wave-selection-controls__kind, .wave-selection-readout__len')].map(node => {
      const { x, width } = node.getBoundingClientRect(); return { x, width };
    }));
  const anchoredReadout = await readoutGeometry();
  const canvas = await page.locator('.wave-waveform-canvas').boundingBox();
  const dragStart = canvas.x + canvas.width * 0.15;
  const dragY = canvas.y + canvas.height / 2;
  const durations = [];
  await page.mouse.move(dragStart, dragY); await page.mouse.down();
  for (const fraction of [0.005, 0.01, 0.02, 0.2, 0.8]) {
    await page.mouse.move(dragStart + canvas.width * fraction, dragY, { steps: 3 });
    await page.waitForTimeout(30);
    durations.push(await page.locator('.wave-selection-readout__len').innerText());
    const geometry = await readoutGeometry();
    geometry.forEach((box, index) => {
      assert(Math.abs(box.x - anchoredReadout[index].x) < 0.1, 'timing controls stay anchored during a drag');
      assert(Math.abs(box.width - anchoredReadout[index].width) < 0.1, 'timing controls keep their width during a drag');
    });
  }
  await page.mouse.up();
  assert.deepEqual(await readoutGeometry(), anchoredReadout, 'committing a drag keeps the controls anchored');
  assert(durations.some(text => text.endsWith(' ms')) && durations.some(text => text.endsWith('s')) && durations.some(text => text.includes(':')),
    'exercise millisecond, second and minute duration formats');
  await word(5).click();
  await word(5).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add pause after', exact: true }).hover();
  await page.getByRole('menuitem', { name: '0.5 s', exact: true }).click();
  await wait(() => window.editorApi().addedPauses().length === 1);
  const pill = page.locator('.wave-pause-pill');
  await pill.waitFor({ state: 'visible' });
  const pauseId = await pill.getAttribute('data-pause-id');
  assert.equal(await pill.innerText(), '+0.5 s ▾');
  assert.equal(await page.locator('.wave-word--pause-token').innerText(), '+0.5 s');
  await pill.click();
  await page.getByRole('menuitem', { name: '2 s', exact: true }).click();
  await wait(() => window.editorApi().addedPauses()[0].ms === 2000);
  assert.equal(await pill.innerText(), '+2 s ▾');
  assert.equal(await pill.getAttribute('data-pause-id'), pauseId);
  assert.equal(await page.locator('.wave-word--pause-token').innerText(), '+2 s');
  await page.locator('.wave-timeline').focus(); await page.keyboard.press('Meta+z');
  await wait(() => window.editorApi().addedPauses()[0].ms === 500);
  await page.locator('.wave-word--pause-token').click();
  await page.getByRole('menuitem', { name: '0.25 s', exact: true }).click();
  await wait(() => window.editorApi().addedPauses()[0].ms === 250);
  await page.waitForTimeout(150);
  await page.reload();
  await wait(() => window.editorApi?.()?.editingState().ready);
  await pill.waitFor({ state: 'visible' });
  assert.equal(await pill.innerText(), '+0.25 s ▾');
  assert.equal(await page.locator('.wave-word--pause-token').innerText(), '+0.25 s');
  for (const width of [960, 1300]) {
    await page.setViewportSize({ width, height: 850 });
    await word(5).click();
    const selectedHeight = await page.locator('.wave-waveform-wrapper').evaluate(el => el.getBoundingClientRect().height);
    await page.locator('.wave-timeline').focus(); await page.keyboard.press('Escape');
    assert.equal(await page.locator('.wave-waveform-wrapper').evaluate(el => el.getBoundingClientRect().height), selectedHeight);
    await word(5).click();
    const fields = await page.locator('.wave-selection-controls').boundingBox();
    assert(fields.x + fields.width <= width && fields.y < 850);
    if (width === 960) {
      const scrolled = await page.locator('.wave-waveform-tools').evaluate(el => {
        el.scrollLeft = 0;
        el.dispatchEvent(new WheelEvent('wheel', { deltaX: 100, bubbles: true, cancelable: true }));
        return el.scrollWidth <= el.clientWidth || el.scrollLeft > 0;
      });
      assert(scrolled, 'all tools remain reachable at the minimum window width');
    }
  }
  await pill.click();
  await page.getByRole('menuitem', { name: /Take out this pause/ }).click();
  await wait(() => window.editorApi().addedPauses().length === 0);
  assert.equal(await pill.count(), 0);
  await word(5).click();
  await page.getByRole('button', { name: 'Delete words', exact: true }).click();
  await wait(() => document.querySelector('[data-word-id="w5"]')?.dataset.audioState === 'removed');
  let state = await snapshot();
  assert(state.cuts[0].startMs < 3500 && state.cuts[0].endMs > 3800, 'text cuts get safe padding');
  // Boundary drags cancel without an edit, commit exactly, and undo once.
  await word(5).click();
  await page.getByRole('button', { name: 'Toggle zoom to selection' }).click();
  await page.waitForTimeout(100);
  const cutHandle = page.locator('.wave-waveform-canvas [part*="cut:"] [part~="region-handle-left"]').first();
  let handle = await cutHandle.boundingBox();
  assert(handle);
  const beforeDrag = state.cuts[0].startMs;
  await page.mouse.move(handle.x + 2, handle.y + handle.height / 2); await page.mouse.down();
  await page.mouse.move(handle.x + 45, handle.y + handle.height / 2, { steps: 5 });
  await page.keyboard.press('Escape'); await page.mouse.up();
  assert.equal((await snapshot()).cuts[0].startMs, beforeDrag);
  handle = await cutHandle.boundingBox();
  await page.mouse.move(handle.x + 2, handle.y + handle.height / 2); await page.mouse.down();
  await page.mouse.move(handle.x + 75, handle.y + handle.height / 2, { steps: 6 }); await page.mouse.up();
  await wait(() => document.querySelector('[data-word-id="w5"]')?.dataset.audioState === 'partial');
  const proposed = await page.evaluate(() => window.editorApi().planEdit([5], []));
  await word(5).click(); await page.getByRole('button', { name: 'Delete words', exact: true }).click();
  await wait(() => document.querySelector('[data-word-id="w5"]')?.dataset.audioState === 'removed');
  assert.equal((await snapshot()).durationMs, proposed.durationMs);
  assert.deepEqual((await snapshot()).cuts, proposed.cuts);
  await page.locator('.wave-timeline').focus(); await page.keyboard.press('Meta+z');
  await wait(() => document.querySelector('[data-word-id="w5"]')?.dataset.audioState === 'partial');
  await page.locator('.wave-timeline').focus(); await page.keyboard.press('Meta+z');
  await wait(() => document.querySelector('[data-word-id="w5"]')?.dataset.audioState === 'removed');
  assert.equal((await snapshot()).cuts[0].startMs, beforeDrag);
  await page.locator('.wave-timeline').focus(); await page.keyboard.press('Meta+z');
  await wait(() => window.editorApi().editingState().cuts.length === 0);
  // Start with a word but make a 1 ms exact waveform trim using the numeric fields.
  await word(5).click();
  await page.getByLabel('Selection start in seconds').fill('3.500');
  await page.getByLabel('Selection start in seconds').press('Enter');
  await page.getByLabel('Selection end in seconds').fill('3.501');
  await page.getByLabel('Selection end in seconds').press('Enter');
  await page.getByLabel('Selection start in seconds').fill('4.000');
  await page.getByLabel('Selection start in seconds').press('Tab');
  assert(await page.getByRole('button', { name: 'Cut audio', exact: true }).isDisabled());
  await page.getByLabel('Selection start in seconds').focus();
  await page.getByLabel('Selection start in seconds').press('Escape');
  assert.equal(await page.getByLabel('Selection start in seconds').inputValue(), '3.500');
  await page.getByRole('button', { name: 'Cut audio', exact: true }).click();
  await wait(() => document.querySelector('[data-word-id="w5"]')?.dataset.audioState === 'partial');
  state = await snapshot();
  assert.equal(state.cuts[0].startMs, 3500); assert.equal(state.cuts[0].endMs, 3501);
  const apiWord = await page.evaluate(() => window.editorApi().words()[5]);
  assert.equal(apiWord.partCut, true); assert.equal(apiWord.cut, false);
  // Restoration must restore actual time cuts and itself be undoable.
  await word(5).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Restore audio', exact: true }).click();
  await wait(() => document.querySelector('[data-word-id="w5"]')?.dataset.audioState === 'kept');
  await page.locator('.wave-timeline').focus(); await page.keyboard.press('Meta+z');
  await wait(() => document.querySelector('[data-word-id="w5"]')?.dataset.audioState === 'partial');
  await page.keyboard.press('Meta+Shift+z');
  await wait(() => window.editorApi().editingState().cuts.length === 0);
  // Tab remains focus navigation. Space on a button does not start audio globally.
  await page.getByRole('button', { name: 'Zoom out', exact: true }).focus();
  await page.keyboard.press('Space');
  assert.equal(await page.getByRole('button', { name: 'Pause', exact: true }).count(), 0);
  await page.locator('.wave-timeline').focus(); await page.keyboard.press('Tab');
  assert.notEqual(await page.evaluate(() => document.activeElement.className), 'wave-timeline');
  // Rapid wheel events preserve the rendered pointer anchor, and resize
  // preserves the visible time window rather than stale pixel coordinates.
  await page.locator('.wave-timeline').focus(); await page.keyboard.press('Shift+z');
  await page.waitForTimeout(100);
  const viewport = () => page.evaluate(() => {
    const el = document.querySelector('.wave-ruler');
    const inner = el.querySelector('.wave-ruler__inner');
    const width = el.clientWidth, zoom = parseFloat(inner.style.width) / 100;
    const scroll = -new DOMMatrixReadOnly(getComputedStyle(inner).transform).m41;
    const duration = window.editorApi().editingState().sourceDurationMs;
    const span = duration / zoom;
    return { width, center: (scroll + width / 2) * duration / (width * zoom), span, pointer: (scroll + width * 0.37) * duration / (width * zoom) };
  });
  const originalView = await viewport();
  await page.locator('.wave-timeline').evaluate(el => {
    const box = el.getBoundingClientRect();
    for (let i = 0; i < 10; i++) el.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -15, clientX: box.left + box.width * 0.37, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(100);
  const zoomedView = await viewport();
  // Browser scroll offsets are quantized to physical pixels at this scale.
  assert(Math.abs(originalView.pointer - zoomedView.pointer) <= zoomedView.span / zoomedView.width);
  assert((await page.locator('.wave-ruler__tick').count()) <= 12);
  await page.setViewportSize({ width: 1500, height: 850 }); await page.waitForTimeout(150);
  const resizedView = await viewport();
  assert(Math.abs(resizedView.center - zoomedView.center) <= Math.max(resizedView.span / resizedView.width, zoomedView.span / zoomedView.width));
  assert(Math.abs(resizedView.span - zoomedView.span) < 2);
  await page.setViewportSize({ width: 1300, height: 850 }); await page.waitForTimeout(150);
  // Session recovery preserves source position, exact selection, view and waveform zoom.
  await page.getByRole('button', { name: 'Segments', exact: true }).click();
  await page.locator('.wave-segments [data-word-id="w90"]').click();
  await page.getByRole('button', { name: 'Toggle zoom to selection' }).click();
  await page.locator('.wave-timeline').focus();
  await page.waitForTimeout(900);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('wave.session.editor-regression')));
  assert.equal(saved.selection.kind, 'words'); assert(saved.spanMs < 45000);
  await page.getByRole('button', { name: /back/i }).first().click();
  await page.getByRole('button', { name: 'Reopen project' }).click();
  await wait(() => window.editorApi?.()?.editingState().ready);
  await page.waitForTimeout(400);
  const start = await page.getByLabel('Selection start in seconds').inputValue();
  assert.equal(start, '46.000');
  assert.equal(await page.locator('.wave-segments').count(), 1);
  assert((await page.locator('.wave-editor-scroll').evaluate(el => el.scrollTop)) > 0);
  assert.equal(await page.getByRole('button', { name: 'Pause', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.className), 'wave-timeline');
  await page.screenshot({ path: '/private/tmp/wave-editor-controls.png' });
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: text/audio sync, exact 1 ms cuts, restore/undo/redo, boundary drag commit/cancel, zoom anchoring, resizing, focus, session recovery in segments view.');
} catch (error) { await page.screenshot({ path: '/private/tmp/wave-editor-failure.png' }); console.log(await page.locator('.wave-timeline').innerText()); console.log('Errors:', errors); console.log(await page.evaluate(() => ({ state: window.editorApi()?.editingState(), words: window.editorApi()?.words().slice(4,7), saved: localStorage.getItem('fixture.edits') }))); throw error; } finally { await browser.close(); }
