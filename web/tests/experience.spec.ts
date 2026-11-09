import { test, expect, type Page } from '@playwright/test';
import { safePublicUrl } from '../src/features/downloads/config';
import { animations } from '../src/features/avatar/catalog';
async function choose(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
  await expect(page.getByRole('combobox', { name: label, exact: true })).toContainText(option);
}
test('release URL validation fails closed', () => {
  for (const url of [undefined, '', 'javascript:alert(1)', '//example.com/app.dmg', 'http://example.com/app.dmg', 'https://user:secret@example.com/app.dmg', '/../../secret']) expect(safePublicUrl(url)).toBeUndefined();
  expect(safePublicUrl('/downloads/athena.dmg')).toBe('/downloads/athena.dmg');
  expect(safePublicUrl('https://example.com/releases/athena.exe')).toBe('https://example.com/releases/athena.exe');
});
test('real VRM, lazy animations, scrolling, demos and personalization', async ({ page }) => {
  const errors: string[] = [];
  const modelRequests: string[] = [];
  const animationRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (request.url().includes('model.vrm')) modelRequests.push(request.url()); if (request.url().includes('.vrma')) animationRequests.push(request.url()); });
  await page.goto('/');
  await expect(page.locator('.scene-stage')).toHaveAttribute('data-ready', 'true', { timeout: 45000 });
  await expect(page.getByRole('heading', { name: 'Meet Athena.' })).toBeVisible();
  await expect(page.locator('main section')).toHaveCount(12);
  await page.locator('.canvas-wrap').evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
  await expect(page.locator('.scene-stage')).toHaveAttribute('data-animation', 'Idle', { timeout: 20000 });
  await page.screenshot({ path: 'test-results/hero-desktop.png' });
  // The initial scene must not eagerly download all 22 animation files.
  expect(new Set(animationRequests).size).toBeLessThan(5);
  const initialLoads = modelRequests.length;
  await page.locator('#meet').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Wave', exact: true }).click();
  await expect(page.locator('.scene-stage')).toHaveAttribute('data-animation', 'Wave');
  await page.getByRole('button', { name: 'Clap', exact: true }).click();
  await expect(page.locator('.scene-stage')).toHaveAttribute('data-animation', 'Clap');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.getByRole('button', { name: 'Rotate Athena left' }).click();
  await page.screenshot({ path: 'test-results/meet-desktop.png' });
  await page.locator('#features').scrollIntoViewIfNeeded();
  await choose(page, 'AI model', 'Online · OpenAI');
  await choose(page, 'Reasoning effort', 'Deep reasoning');
  await choose(page, 'Sample attachment', 'project-brief.md');
  await page.getByLabel('Message Athena demo').fill('Help with this project');
  await page.getByRole('button', { name: 'Send demo message' }).click();
  await expect(page.locator('.chat-log')).toContainText('sample project-brief.md');
  await expect(page.getByRole('button', { name: 'Send demo message' })).toBeDisabled(); // empty composer
  await page.locator('#voice').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Try a conversation' }).click();
  await expect(page.locator('.voice-transcript')).toContainText('simulated');
  await page.getByRole('button', { name: 'Stop preview' }).click();
  await page.locator('#intelligence').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Online AI', exact: true }).click();
  await expect(page.locator('.intelligence-detail')).toContainText('online provider');
  await page.getByRole('switch', { name: 'Contextual memory demo' }).click();
  await expect(page.locator('.memory-flow')).toContainText('Only the current message');
  await page.locator('#development').scrollIntoViewIfNeeded();
  await choose(page, 'Development agent', 'Claude Code');
  await page.getByRole('button', { name: 'Fix the greeting bug' }).click();
  await expect(page.locator('.terminal-output')).toContainText('2 sample tests passed');
  await expect(page.getByLabel('Sample source code')).toContainText("name?.trim() || 'friend'");
  await page.locator('#personalization').scrollIntoViewIfNeeded();
  await page.getByLabel('Avatar size').fill('0.85');
  await expect(page.locator('label[for="avatar-size"] output')).toContainText('85%');
  await page.getByRole('button', { name: 'Violet lighting' }).click();
  await expect(page.getByRole('button', { name: 'Violet lighting' })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: 'test-results/personalization-desktop.png' });
  await page.locator('#downloads').scrollIntoViewIfNeeded();
  await expect(page.locator('#downloads .download-button')).toHaveCount(2);
  for (const button of await page.locator('.download-button').all()) await expect(button).toBeDisabled();
  await page.locator('#closing').scrollIntoViewIfNeeded();
  await expect(page.getByRole('heading', { name: 'Your AI. Your companion. Your Athena.' })).toBeVisible();
  expect(modelRequests.length).toBe(initialLoads);
  expect(errors).toEqual([]);
});
test('mobile navigation, layout and reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('.scene-stage')).toHaveAttribute('data-ready', 'true', { timeout: 45000 });
  await expect(page.getByRole('button', { name: 'Reduce motion', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Motion reduced' })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: 'test-results/hero-mobile.png' });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('navigation').getByRole('link', { name: 'Personalization' }).click();
  await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('Animation speed')).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/personalization-mobile.png' });
});
test('WebGL failure leaves all content and download states accessible', async ({ page }) => {
  await page.addInitScript(() => { const original = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) { if (type.includes('webgl')) return null; return original.apply(this, [type, ...args] as Parameters<typeof original>); } as typeof original; });
  await page.goto('/');
  await expect(page.getByText('The 3D preview is unavailable on this device.')).toBeVisible();
  await expect(page.locator('main section')).toHaveCount(12);
  await expect(page.locator('#downloads .download-button').first()).toBeDisabled();
});
test('model load failure shows fallback', async ({ page }) => {
  await page.route('**/models/model.vrm', route => route.abort());
  await page.goto('/');
  await expect(page.getByText('The 3D preview is unavailable on this device.')).toBeVisible();
  await expect(page.locator('#features')).toContainText('Big ideas.');
});
test('retained original animations bind and removed actions stay unavailable', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#meet');
  await expect(page.locator('.scene-stage')).toHaveAttribute('data-ready', 'true', { timeout: 45000 });
  for (const name of ['sit', 'flip', 'flight', 'landing', 'spinning']) expect(animations[name]).toBeUndefined();
  for (const animation of Object.values(animations)) {
    await choose(page, 'More expressions', animation.label);
    await expect(page.locator('.scene-stage')).toHaveAttribute('data-animation', animation.label);
  }
  expect(errors).toEqual([]);
});
test('missing animation reports its idle fallback', async ({ page }) => {
  await page.route('**/animations/jump.vrma', route => route.abort());
  await page.goto('/#meet');
  await expect(page.locator('.scene-stage')).toHaveAttribute('data-ready', 'true', { timeout: 45000 });
  await page.getByRole('button', { name: 'Jump', exact: true }).click();
  await expect(page.locator('.scene-stage')).toHaveAttribute('data-animation', 'Jump unavailable · using Idle');
});
test('tablet layout keeps controls and download cards inside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto('/#downloads');
  await expect(page.locator('.scene-stage')).toHaveAttribute('data-ready', 'true', { timeout: 45000 });
  await page.locator('#downloads h2').scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('#downloads .download-card')).toHaveCount(2);
  await page.locator('.canvas-wrap').evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
  await page.screenshot({ path: 'test-results/downloads-tablet.png' });
});
