// @ts-check
const { test, expect } = require('@playwright/test');
const { loginBypass } = require('./helpers');

test.describe('Demo guidata', () => {
  test('il pannello demo compare al click sul pulsante', async ({ page }) => {
    await loginBypass(page, 'struttura1');

    await page.evaluate(() => window.runDemo());

    // Il pannello guidato deve essere visibile con "Passo 1/34"
    const panel = page.locator('#demo-guide-panel');
    await expect(panel).toBeVisible({ timeout: 5000 });
    await expect(panel).toContainText('1/34');
  });

  test('stopDemo rimuove il pannello demo', async ({ page }) => {
    await loginBypass(page, 'struttura1');
    await page.evaluate(() => window.runDemo());
    await page.locator('#demo-guide-panel').waitFor({ state: 'visible' });

    await page.evaluate(() => window.stopDemo());

    await expect(page.locator('#demo-guide-panel')).toBeHidden();
  });

  test('durante la demo S.demoMode è true (nessuna email reale)', async ({ page }) => {
    await loginBypass(page, 'struttura1');
    await page.evaluate(() => window.runDemo());
    await page.locator('#demo-guide-panel').waitFor({ state: 'visible' });

    const demoMode = await page.evaluate(() => window._S.demoMode);
    expect(demoMode).toBe(true);
  });

  test('dopo stopDemo S.demoMode torna false', async ({ page }) => {
    await loginBypass(page, 'struttura1');
    await page.evaluate(() => window.runDemo());
    await page.locator('#demo-guide-panel').waitFor({ state: 'visible' });
    await page.evaluate(() => window.stopDemo());

    const demoMode = await page.evaluate(() => window._S.demoMode);
    expect(demoMode).toBe(false);
  });
});
