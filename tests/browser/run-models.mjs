import assert from 'node:assert/strict';
const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await playwright.webkit.launch({ headless: true, executablePath: process.env.BROWSER_PATH });
const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
try {
  await page.goto('http://localhost:1420/tests/fixtures/models.html');
  const choice = page.getByLabel('Transcription model', { exact: true });
  await choice.waitFor();
  assert.equal(await choice.inputValue(), 'large-v3-turbo');
  assert(await choice.locator('option[value="parakeet-tdt-0.6b-v3"]').isDisabled());
  const row = page.locator('.wave-model-row').filter({ hasText: 'Parakeet v3' });
  await row.getByRole('button', { name: 'Download', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('option[value="parakeet-tdt-0.6b-v3"]').disabled);
  assert.equal(await choice.inputValue(), 'large-v3-turbo', 'downloading never changes the saved model');
  await choice.selectOption('parakeet-tdt-0.6b-v3');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('fixture.settings')).selectedModelId === 'parakeet-tdt-0.6b-v3');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#transcription-model').value === 'parakeet-tdt-0.6b-v3');
  await page.screenshot({ path: '/private/tmp/wave-parakeet-settings.png', fullPage: true });
  await row.getByRole('button', { name: 'Delete Parakeet v3' }).click();
  await page.waitForFunction(() => document.querySelector('#transcription-model').value === 'large-v3-turbo');
  await page.getByRole('button', { name: 'Delete Whisper', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#transcription-model').value === '');
  assert.equal(await choice.locator('option[value="large-v3-turbo"]').isDisabled(), true);
  await row.getByRole('button', { name: 'Download', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#transcription-model').value === 'parakeet-tdt-0.6b-v3');
  assert.deepEqual(errors, []);
  console.log('Model settings passed: download/select, saved choice, fallback on deletion and Parakeet without the Whisper aligner.');
} catch (error) {
  await page.screenshot({ path: '/private/tmp/wave-parakeet-settings-failure.png', fullPage: true });
  throw error;
} finally { await browser.close(); }
