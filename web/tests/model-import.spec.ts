import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MAX_PREVIEW_BYTES, validateModelFile, validateModelName, validateVrmBytes, VROID_DOWNLOAD_URL } from '../src/features/avatar/importValidation';

const fixture = resolve('public/models/model.vrm');
function glb(json: unknown) {
  const text = JSON.stringify(json);
  const payload = Buffer.from(text + ' '.repeat((4 - Buffer.byteLength(text) % 4) % 4));
  const buffer = new ArrayBuffer(payload.length + 20);
  const view = new DataView(buffer);
  [0x46546c67, 2, buffer.byteLength, payload.length, 0x4e4f534a].forEach((value, i) => view.setUint32(i * 4, value, true));
  new Uint8Array(buffer, 20).set(payload);
  return buffer;
}
test('desktop naming rules and self-contained VRM validation protect local previews', () => {
  expect(validateModelName(' Nova ')).toBe('Nova');
  for (const name of ['', ' ', 'ATHENA', 'Ａｔｈｅｎａ', 'Athena Classic', 'a'.repeat(61), 'Nova\u0000', 'Nova\u200b']) expect(() => validateModelName(name)).toThrow();
  expect(() => validateModelFile({ name: 'nova.vroid', size: 100 })).toThrow('exported .vrm');
  expect(() => validateModelFile({ name: 'nova.vrm', size: MAX_PREVIEW_BYTES + 1 })).toThrow('50 MB');
  expect(() => validateVrmBytes(new ArrayBuffer(10))).toThrow('valid VRM');
  const original = readFileSync(fixture);
  const bytes = new Uint8Array(original).buffer;
  expect(() => validateVrmBytes(bytes)).not.toThrow();
  const length = new DataView(bytes).getUint32(12, true);
  const metadata = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, length)));
  metadata.images = [{ uri: 'https://example.com/private-texture.png' }];
  expect(() => validateVrmBytes(glb(metadata))).toThrow('External asset links');
  metadata.images = []; metadata.extensions = {};
  expect(() => validateVrmBytes(glb(metadata))).toThrow('does not contain a VRM');
});

test('local VRM preview, animation, rename, replacement and cached Athena restore', async ({ page }) => {
  const errors: string[] = [];
  const uploads: string[] = [];
  let originalLoads = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => {
    if (request.url().endsWith('/models/model.vrm')) originalLoads++;
    if (request.method() !== 'GET') uploads.push(request.url());
  });
  await page.goto('/#personalization');
  const scene = page.locator('.scene-stage');
  await expect(scene).toHaveAttribute('data-ready', 'true', { timeout: 45000 });
  await page.getByLabel('Companion name').fill('Nova');
  await page.getByLabel('Choose VRM file', { exact: true }).setInputFiles(fixture);
  await page.getByRole('button', { name: 'Preview my model', exact: true }).click();
  await expect(scene).toHaveAttribute('data-model', 'custom');
  await expect(scene).toHaveAttribute('data-model-name', 'Nova');
  await expect(page.locator('.model-import-message')).toContainText('Nova is ready');
  await page.getByRole('button', { name: 'Say hello' }).click();
  await expect(scene).toHaveAttribute('data-animation', 'Wave');
  await page.getByLabel('Companion name').fill('Nova Aurora');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(scene).toHaveAttribute('data-model-name', 'Nova Aurora');
  await page.getByRole('button', { name: 'Rotate Nova Aurora left' }).click();
  await page.locator('.model-import').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/model-import-desktop.png' });
  await page.locator('#meet').scrollIntoViewIfNeeded();
  await expect(scene).toHaveAttribute('data-model-name', 'Nova Aurora');
  await page.getByRole('button', { name: 'Clap', exact: true }).click();
  await expect(scene).toHaveAttribute('data-animation', 'Clap');
  // An invalid replacement must leave the last successful model visible.
  await page.getByLabel('Choose VRM file', { exact: true }).setInputFiles({ name: 'broken.vrm', mimeType: 'application/octet-stream', buffer: Buffer.from('broken') });
  await page.getByRole('button', { name: 'Preview my model', exact: true }).click();
  await expect(page.locator('.model-import-message')).toContainText('not a valid VRM');
  await expect(scene).toHaveAttribute('data-model-name', 'Nova Aurora');
  await page.getByLabel('Choose VRM file', { exact: true }).setInputFiles(fixture);
  await page.getByLabel('Companion name').fill('Luna');
  await page.getByRole('button', { name: 'Preview my model', exact: true }).click();
  await expect(scene).toHaveAttribute('data-model-name', 'Luna');
  await page.getByRole('button', { name: 'Restore Athena' }).click();
  await expect(scene).toHaveAttribute('data-model', 'athena');
  await expect(scene).toHaveAttribute('data-model-name', 'Athena');
  await page.getByRole('button', { name: 'Say hello' }).click();
  await expect(scene).toHaveAttribute('data-animation', 'Wave');
  expect(originalLoads).toBe(1);
  expect(uploads).toEqual([]);
  expect(errors).toEqual([]);
});

test('invalid file and reserved-name feedback, official VRoid link opens a separate tab', async ({ page }) => {
  await page.goto('/#personalization');
  await expect(page.locator('.scene-stage')).toHaveAttribute('data-ready', 'true', { timeout: 45000 });
  await page.getByLabel('Choose VRM file', { exact: true }).setInputFiles({ name: 'character.vroid', mimeType: 'application/octet-stream', buffer: Buffer.from('project') });
  await expect(page.locator('.model-import-message')).toContainText('Export your .vroid project');
  await page.getByLabel('Choose VRM file', { exact: true }).setInputFiles(fixture);
  await page.getByLabel('Companion name').fill('Athena');
  await page.getByRole('button', { name: 'Preview my model', exact: true }).click();
  await expect(page.locator('.model-import-message')).toContainText('built-in model name');
  const link = page.getByRole('link', { name: 'Download VRoid Studio' });
  await expect(link).toHaveAttribute('href', VROID_DOWNLOAD_URL);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  // Stub only the external page; the anchor/popup behavior is real.
  await page.context().route(VROID_DOWNLOAD_URL, route => route.fulfill({ contentType: 'text/html', body: '<title>VRoid Studio download destination</title>' }));
  const popupPromise = page.waitForEvent('popup');
  await link.click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  expect(popup.url()).toBe(VROID_DOWNLOAD_URL);
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  await popup.close();
});

test('canceling a pending avatar import cannot replace Athena after it finishes', async ({ page }) => {
  await page.goto('/#personalization');
  await expect(page.locator('.scene-stage')).toHaveAttribute('data-ready', 'true', { timeout: 45000 });
  let release: () => void = () => {};
  let requested = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/animations/idle.vrma', async route => { requested = true; await gate; await route.continue(); });
  await page.getByLabel('Companion name').fill('Canceled model');
  await page.getByLabel('Choose VRM file', { exact: true }).setInputFiles(fixture);
  await page.getByRole('button', { name: 'Preview my model', exact: true }).click();
  await expect.poll(() => requested).toBe(true);
  await page.getByRole('button', { name: 'Cancel preview' }).click();
  const response = page.waitForResponse('**/animations/idle.vrma');
  release(); await (await response).finished();
  // Allow the completed retargeting promise and subsequent render frames to settle.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));
  await expect(page.locator('.scene-stage')).toHaveAttribute('data-model-name', 'Athena');
  await expect(page.locator('.model-import-message')).toContainText('Athena restored');
});

test('mobile upload form fits the viewport; fallback keeps VRoid guidance accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#personalization');
  await expect(page.locator('.scene-stage')).toHaveAttribute('data-ready', 'true', { timeout: 45000 });
  await page.getByLabel('Companion name').fill('N'.repeat(60));
  await page.getByLabel('Choose VRM file', { exact: true }).setInputFiles(fixture);
  await page.getByRole('button', { name: 'Preview my model', exact: true }).click();
  await expect(page.locator('.scene-stage')).toHaveAttribute('data-model', 'custom');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel('Companion name').evaluate(element => element.scrollIntoView({ block: 'start' }));
  const nameBox = await page.getByLabel('Companion name').boundingBox();
  const stageBox = await page.locator('.scene-stage').boundingBox();
  expect(nameBox!.y).toBeGreaterThan(stageBox!.y + stageBox!.height);
  await expect(page.locator('.model-import')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: 'artifacts/model-import-mobile.png' });
  await page.route('**/models/model.vrm', route => route.abort());
  await page.reload();
  await expect(page.getByText('The 3D preview is unavailable on this device.')).toBeVisible();
  await expect(page.getByLabel('Choose VRM file', { exact: true })).toBeDisabled();
  await page.getByRole('link', { name: 'Download VRoid Studio' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('link', { name: 'Download VRoid Studio' })).toBeVisible();
});
