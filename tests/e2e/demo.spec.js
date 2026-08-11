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

  test('removeDemoPatients rimuove anche il documento di consenso della richiesta urgente', async ({ page }) => {
    await loginBypass(page, 'struttura1');

    // requestImmediate (usata dalla demo per la "Second Opinion Urgente") crea sia la televisita
    // sia un documento di consenso collegato: entrambi devono sparire, non solo la televisita
    // (bug reale: il documento non aveva tvId e restava orfano dopo la pulizia).
    await page.evaluate(() => {
      window._S.demoMode = true;
      window.requestImmediate('Demo Doc Test', 'demo.doc@test.invalid', '', '1980-01-01', 'M', 'Roma', 'CF', '');
    });

    const before = await page.evaluate(() => ({
      tv: window._S.televisite.some(t => t.patient === 'Demo Doc Test'),
      doc: window._S.docs.some(d => d.patient === 'Demo Doc Test')
    }));
    expect(before.tv).toBe(true);
    expect(before.doc).toBe(true);

    await page.evaluate(() => window.removeDemoPatients());

    const after = await page.evaluate(() => ({
      tv: window._S.televisite.some(t => t.patient === 'Demo Doc Test'),
      doc: window._S.docs.some(d => d.patient === 'Demo Doc Test')
    }));
    expect(after.tv).toBe(false);
    expect(after.doc).toBe(false);
  });
});
