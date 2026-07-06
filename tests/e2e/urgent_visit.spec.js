// @ts-check
const { test, expect } = require('@playwright/test');
const { loginBypass } = require('./helpers');

test.describe('Visita urgente (Second Opinion)', () => {
  test('richiesta urgente compare nella lista visite struttura1', async ({ page }) => {
    await loginBypass(page, 'struttura1');

    await page.evaluate(() => {
      window.requestImmediate('Urgente Test', 'urgente@test.invalid', '+39 333 000 0099',
        '1975-06-15', 'M', 'Roma', 'CF', '');
    });

    // Il paziente urgente appare nella lista visite, non nella sezione di controllo urgenze
    await expect(page.locator('#vlist-s1')).toContainText('Urgente Test');
    // La sezione urgenze deve mostrare "In attesa di risposta"
    await expect(page.locator('#card-urgente-section')).toContainText('In attesa di risposta');
  });

  test('struttura2 vede la richiesta urgente con il pannello di accettazione', async ({ page }) => {
    await loginBypass(page, 'struttura1');

    await page.evaluate(() => {
      window.requestImmediate('Urgente Sync', 'urgente.sync@test.invalid', '',
        '1980-01-01', 'F', 'Milano', 'CF', '');
    });

    await page.evaluate(() => window.switchRole('struttura2'));
    // Struttura2 vede il pannello di accettazione urgente
    await expect(page.locator('#card-urgente-section')).toContainText('Second Opinion Urgente');
  });

  test('struttura2 può accettare la richiesta urgente', async ({ page }) => {
    await loginBypass(page, 'struttura1');

    await page.evaluate(() => {
      window.requestImmediate('Urgente Accetta', 'urgente.ok@test.invalid', '',
        '1990-03-20', 'M', 'Torino', 'CF', '');
    });

    await page.evaluate(() => window.switchRole('struttura2'));
    await page.evaluate(() => window.acceptImmediate());

    // Dopo l'accettazione lo stato è "accepted" (diventa "in-corso" solo entrando in Jitsi)
    const status = await page.evaluate(() => window._S.immReq);
    expect(status).toBe('accepted');
    // La sezione urgente deve confermare l'accettazione
    await expect(page.locator('#card-urgente-section')).toContainText('Second Opinion Avviata');
  });

  test('visita urgente ha consenso firmato automaticamente', async ({ page }) => {
    await loginBypass(page, 'struttura1');

    await page.evaluate(() => {
      window.requestImmediate('Urgente Consent', 'urgente.consent@test.invalid', '',
        '1988-11-05', 'M', 'Bologna', 'CF', '');
    });

    const tv = await page.evaluate(() => {
      return window._S.televisite.find(t => t.patient === 'Urgente Consent');
    });
    expect(tv).not.toBeNull();
    expect(tv.consentStatus).toBe('firmato');
  });
});

test.describe('Accesso Centro Urgente', () => {
  test('accesso centro urgente crea visita in-corso con nota legale', async ({ page }) => {
    await loginBypass(page, 'struttura1');

    await page.evaluate(() => {
      document.getElementById('cu-patient').value = 'Centro Urgente Test';
      document.getElementById('cu-email').value = 'centro.urgente@test.invalid';
      document.getElementById('cu-phone').value = '+39 333 000 0088';
      document.getElementById('cu-dob').value = '1970-05-10';
      window.submitCentroUrgentRequest(null);
    });

    const tv = await page.evaluate(() => {
      return window._S.televisite.find(t => t.patient === 'Centro Urgente Test');
    });

    expect(tv).not.toBeNull();
    expect(tv.status).toBe('in-corso');
    expect(tv.legalNote).toContain('consenso presunto');
    expect(tv.legalNote).toContain('art. 54 c.p.');
  });

  test('accesso centro urgente non appare nel cruscotto struttura2', async ({ page }) => {
    await loginBypass(page, 'struttura1');

    await page.evaluate(() => {
      document.getElementById('cu-patient').value = 'Privato Centro';
      document.getElementById('cu-email').value = 'privato@test.invalid';
      window.submitCentroUrgentRequest(null);
    });

    await page.evaluate(() => window.switchRole('struttura2'));
    await expect(page.locator('#vlist-s2')).not.toContainText('Privato Centro');
  });
});
