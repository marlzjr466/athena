/** @jsxImportSource react */
import { test, expect } from '@playwright/test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DownloadButton } from '../src/features/downloads/Downloads';
import { downloads } from '../src/features/downloads/config';
test('a configured release renders a direct download and downloads the fixture', async ({ page }) => {
  const original = downloads.macos;
  downloads.macos = { ...original, url: '/downloads/fixture.dmg' };
  try {
    // Fixture-only bytes, never shipped or configured as an Athena installer.
    await page.route('**/downloads/fixture.dmg', route => route.fulfill({ body: 'download test fixture', contentType: 'application/octet-stream', headers: { 'Content-Disposition': 'attachment; filename="fixture.dmg"' } }));
    await page.goto('/');
    await page.setContent(renderToStaticMarkup(<DownloadButton platform="macos" />));
    const link = page.getByRole('link', { name: 'Download for macOS' });
    await expect(link).toHaveAttribute('href', '/downloads/fixture.dmg');
    await expect(link).toHaveAttribute('download', '');
    const result = page.waitForEvent('download');
    await link.click();
    expect((await result).suggestedFilename()).toBe('fixture.dmg');
  } finally { downloads.macos = original; }
});
