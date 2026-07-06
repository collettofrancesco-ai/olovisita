// @ts-check
const { test, expect } = require('@playwright/test');
const { loginBypass, todayStr, futureTime } = require('./helpers');

test.describe('Creazione visita programmata', () => {
  test('visita network compare nella lista con stato "Programmata"', async ({ page }) => {
    await loginBypass(page, 'struttura1');

    await page.fill('#f-patient', 'Playwright Network');
    await page.fill('#f-email', 'playwright.network@test.invalid');
    await page.fill('#f-phone', '+39 333 000 0001');
    await page.selectOption('#f-visit-mode', 'network');
    await page.fill('#f-date', todayStr());
    await page.fill('#f-time', futureTime(60));
    await page.locator('#sched-form button[type="submit"]').click();

    const list = page.locator('#vlist-s1');
    await expect(list).toContainText('Playwright Network');
    // Visita network = deve aspettare accettazione da struttura2
    await expect(list.filter({ hasText: 'Playwright Network' })).toContainText('Programmata');
  });

  test('visita centro è già "Accettata" senza passare da struttura2', async ({ page }) => {
    await loginBypass(page, 'struttura1');

    await page.fill('#f-patient', 'Playwright Centro');
    await page.fill('#f-email', 'playwright.centro@test.invalid');
    await page.selectOption('#f-visit-mode', 'centro');
    await page.fill('#f-date', todayStr());
    await page.fill('#f-time', futureTime(120));
    await page.locator('#sched-form button[type="submit"]').click();

    const list = page.locator('#vlist-s1');
    await expect(list).toContainText('Playwright Centro');
    await expect(list.filter({ hasText: 'Playwright Centro' })).toContainText('Accettata');
  });

  test('la visita programmata compare anche nella vista struttura2', async ({ page }) => {
    await loginBypass(page, 'struttura1');

    await page.fill('#f-patient', 'Playwright Visibile');
    await page.fill('#f-email', 'playwright.visibile@test.invalid');
    await page.selectOption('#f-visit-mode', 'network');
    await page.fill('#f-date', todayStr());
    await page.fill('#f-time', futureTime(150));
    await page.locator('#sched-form button[type="submit"]').click();

    // Cambia vista a struttura2
    await page.evaluate(() => window.switchRole('struttura2'));
    await expect(page.locator('#vlist-s2')).toContainText('Playwright Visibile');
  });

  test('struttura2 può accettare una visita network', async ({ page }) => {
    await loginBypass(page, 'struttura1');

    await page.fill('#f-patient', 'Playwright Accetta');
    await page.fill('#f-email', 'playwright.accetta@test.invalid');
    await page.selectOption('#f-visit-mode', 'network');
    await page.fill('#f-date', todayStr());
    await page.fill('#f-time', futureTime(180));
    await page.locator('#sched-form button[type="submit"]').click();

    // Struttura2 accetta
    await page.evaluate(() => window.switchRole('struttura2'));
    const list2 = page.locator('#vlist-s2');
    await expect(list2).toContainText('Playwright Accetta');

    // Trova il tvId della visita creata e accettala
    const tvId = await page.evaluate(() => {
      const tv = window._S.televisite.find(t => t.patient === 'Playwright Accetta');
      return tv ? tv.id : null;
    });
    expect(tvId).not.toBeNull();
    await page.evaluate((id) => window.acceptSched(id), tvId);

    await expect(list2.filter({ hasText: 'Playwright Accetta' })).toContainText('Accettata');
  });
});
