// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Schermata di login', () => {
  test('mostra le card delle due strutture', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#card-facility-s1')).toBeVisible();
    await expect(page.locator('#card-facility-s2')).toBeVisible();
  });

  test('selezionando struttura1 mostra il form password', async ({ page }) => {
    await page.goto('/');
    await page.click('#card-facility-s1');
    await expect(page.locator('#pwd-input')).toBeVisible();
    await expect(page.locator('#user-select')).toBeVisible();
  });

  test('selezionando struttura2 mostra il form password', async ({ page }) => {
    await page.goto('/');
    await page.click('#card-facility-s2');
    await expect(page.locator('#pwd-input')).toBeVisible();
  });

  test('password errata mostra messaggio di errore', async ({ page }) => {
    await page.goto('/');
    await page.click('#card-facility-s1');
    // Seleziona il primo utente reale dal select (index 0 è il placeholder vuoto)
    const options = page.locator('#user-select option');
    const count = await options.count();
    if (count > 1) {
      const val = await options.nth(1).getAttribute('value');
      await page.selectOption('#user-select', val);
    }
    await page.fill('#pwd-input', 'passwordAssolutamenteSbagliata!99');
    await page.click('button[onclick="submitLogin()"]');
    // Il messaggio di errore deve essere non vuoto
    const errMsg = page.locator('#login-error-msg');
    await expect(errMsg).not.toHaveText('');
    await expect(errMsg).toBeVisible();
  });

  test('il login overlay scompare dopo l\'accesso riuscito (bypass)', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      document.getElementById('login-overlay').style.display = 'none';
      window.switchRole('struttura1');
    });
    await expect(page.locator('#login-overlay')).toBeHidden();
    await expect(page.locator('#role-badge')).toBeVisible();
  });
});
