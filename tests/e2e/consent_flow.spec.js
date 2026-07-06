// @ts-check
const { test, expect } = require('@playwright/test');
const { loginBypass, todayStr, futureTime } = require('./helpers');

test.describe('Flusso consenso informato', () => {
  // Crea una visita accettata e restituisce il tvId
  async function createAcceptedVisit(page, patient, timeOffset) {
    await loginBypass(page, 'struttura1');
    await page.fill('#f-patient', patient);
    await page.fill('#f-email', 'consent@test.invalid');
    await page.selectOption('#f-visit-mode', 'network');
    await page.fill('#f-date', todayStr());
    await page.fill('#f-time', futureTime(timeOffset));
    await page.locator('#sched-form button[type="submit"]').click();

    const tvId = await page.evaluate((p) => {
      const tv = window._S.televisite.find(t => t.patient === p);
      return tv ? tv.id : null;
    }, patient);
    expect(tvId).not.toBeNull();

    await page.evaluate(() => window.switchRole('struttura2'));
    await page.evaluate((id) => window.acceptSched(id), tvId);
    await page.evaluate(() => window.switchRole('struttura1'));
    return tvId;
  }

  // Simula il click su "Accetto" del paziente (genera l'OTP come fa unlockConsentOtp)
  async function patientAcceptsConsent(page, tvId) {
    return page.evaluate((id) => {
      const tv = window._S.televisite.find(t => t.id === id);
      if (!tv) return null;
      const otp = Math.floor(1000 + Math.random() * 9000).toString();
      tv.consentOtp = otp;
      tv.otpAttempts = 0;
      return otp;
    }, tvId);
  }

  test('invio consenso porta lo stato a "inviato"', async ({ page }) => {
    const tvId = await createAcceptedVisit(page, 'Consenso Test', 60);

    await page.evaluate((id) => window.sendConsentEmail(id), tvId);

    const status = await page.evaluate((id) => {
      return window._S.televisite.find(t => t.id === id)?.consentStatus;
    }, tvId);
    expect(status).toBe('inviato');
  });

  test('verifica OTP corretto porta il consenso a "firmato"', async ({ page }) => {
    const tvId = await createAcceptedVisit(page, 'OTP Test', 120);
    await page.evaluate((id) => window.sendConsentEmail(id), tvId);
    const otp = await patientAcceptsConsent(page, tvId);
    expect(otp).not.toBeNull();

    await page.evaluate(({ id, code }) => {
      const panel = document.getElementById('p-s1');
      const input = panel?.querySelector(`#otp-input-${id}`);
      if (input) { input.value = code; window.verifyConsentOtp(id); }
    }, { id: tvId, code: otp });

    const finalStatus = await page.evaluate((id) => {
      return window._S.televisite.find(t => t.id === id)?.consentStatus;
    }, tvId);
    expect(finalStatus).toBe('firmato');
  });

  test('OTP errato non firma il consenso', async ({ page }) => {
    const tvId = await createAcceptedVisit(page, 'OTP Sbagliato', 180);
    await page.evaluate((id) => window.sendConsentEmail(id), tvId);
    await patientAcceptsConsent(page, tvId);

    await page.evaluate((id) => {
      const panel = document.getElementById('p-s1');
      const input = panel?.querySelector(`#otp-input-${id}`);
      if (input) { input.value = '0000'; window.verifyConsentOtp(id); }
    }, tvId);

    const status = await page.evaluate((id) => {
      return window._S.televisite.find(t => t.id === id)?.consentStatus;
    }, tvId);
    expect(status).toBe('inviato');
  });

  test('visita urgente ha consenso presunto automatico con nota legale', async ({ page }) => {
    await loginBypass(page, 'struttura1');
    await page.evaluate(() => {
      window.requestImmediate('Urgente Consenso', 'urgente.consenso@test.invalid', '',
        '1985-07-22', 'M', 'Napoli', 'CF', '');
    });
    const tv = await page.evaluate(() => {
      return window._S.televisite.find(t => t.patient === 'Urgente Consenso');
    });
    expect(tv.consentStatus).toBe('firmato');
    expect(tv.legalNote).toContain('art. 54 c.p.');
  });

  test('il consenso firmato appare nella card come badge "Firmato"', async ({ page }) => {
    const tvId = await createAcceptedVisit(page, 'Badge Firmato', 240);
    await page.evaluate((id) => window.sendConsentEmail(id), tvId);
    const otp = await patientAcceptsConsent(page, tvId);

    await page.evaluate(({ id, code }) => {
      const panel = document.getElementById('p-s1');
      const input = panel?.querySelector(`#otp-input-${id}`);
      if (input) { input.value = code; window.verifyConsentOtp(id); }
    }, { id: tvId, code: otp });

    const card = page.locator('#vlist-s1').filter({ hasText: 'Badge Firmato' });
    await expect(card).toContainText('Firmato');
  });
});
