// Canale di controllo tenuto vivo dalle strutture: niente ritorni a copie più vecchie,
// avviso chiaro su un PC senza Codice Stanza. Nessuna connessione MQTT reale: le firme sono
// fatte con una coppia di chiavi di prova generata nel browser.
const { test, expect } = require('@playwright/test');
const { loginBypass } = require('./helpers');

async function setupSigner(page) {
  await page.evaluate(async () => {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    cachedAdminControlPublicKey = kp.publicKey;
    window.__signControl = async (obj) => {
      const data = JSON.stringify(obj);
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(data));
      return JSON.stringify({ data, signature: arrayBufferToBase64(sig) });
    };
    activeFacilityId = 'struttura1';
  });
}

test.describe('Canale di controllo tenuto vivo dalle strutture', () => {
  test('una copia più vecchia non riporta indietro il Codice Stanza', async ({ page }) => {
    await loginBypass(page, 'struttura1');
    await setupSigner(page);
    const result = await page.evaluate(async () => {
      currentGroupCode = 'codice-nuovo-di-prova';
      localStorage.setItem('tv_current_group_code', 'codice-nuovo-di-prova');
      cacheControlOverride('struttura1', { users: {}, groupCode: 'codice-nuovo-di-prova', updatedAt: 2000 });
      await handleFacilityControlMessage(await window.__signControl({ users: {}, groupCode: 'codice-vecchio-di-prova', updatedAt: 1000 }));
      return {
        code: currentGroupCode,
        stored: localStorage.getItem('tv_current_group_code'),
        cachedAt: readCachedControlOverride('struttura1').updatedAt,
        envelopeAt: (readCachedControlEnvelope('struttura1') || { updatedAt: null }).updatedAt,
      };
    });
    expect(result.code).toBe('codice-nuovo-di-prova');
    expect(result.stored).toBe('codice-nuovo-di-prova');
    expect(result.cachedAt).toBe(2000);
    // La copia vecchia non va conservata: il PC la ripubblicherebbe sul broker.
    expect(result.envelopeAt).toBeNull();
  });

  test('la copia firmata conservata resta sempre la più recente', async ({ page }) => {
    await loginBypass(page, 'struttura1');
    await setupSigner(page);
    const result = await page.evaluate(async () => {
      currentGroupCode = 'codice-di-prova';
      const newer = await window.__signControl({ users: {}, groupCode: 'codice-di-prova', updatedAt: 3000 });
      const older = await window.__signControl({ users: {}, groupCode: 'codice-di-prova', updatedAt: 1000 });
      await handleFacilityControlMessage(newer);
      await handleFacilityControlMessage(older);
      const cached = readCachedControlEnvelope('struttura1');
      return { updatedAt: cached.updatedAt, sameBytes: cached.raw === newer, overrideAt: readCachedControlOverride('struttura1').updatedAt };
    });
    expect(result.updatedAt).toBe(3000);
    expect(result.sameBytes).toBe(true);
    expect(result.overrideAt).toBe(3000);
  });

  test('un messaggio con firma non valida non viene conservato', async ({ page }) => {
    await loginBypass(page, 'struttura1');
    await setupSigner(page);
    const cached = await page.evaluate(async () => {
      const good = JSON.parse(await window.__signControl({ users: {}, updatedAt: 5000 }));
      const forged = JSON.stringify({ data: JSON.stringify({ users: {}, groupCode: 'falso', updatedAt: 9000 }), signature: good.signature });
      await handleFacilityControlMessage(forged);
      return readCachedControlEnvelope('struttura1');
    });
    expect(cached).toBeNull();
  });

  test('PC senza Codice Stanza: avviso visibile, sparisce quando il codice arriva', async ({ page }) => {
    await loginBypass(page, 'struttura1');
    await setupSigner(page);
    await page.evaluate(() => {
      localStorage.removeItem('tv_admin_control_struttura1');
      currentGroupCode = atob('T2xvdmlzaXRhX3BhbGVybW9fdHVuaXNpYQ==');
      ownControlSeenThisSession = false;
      checkControlMissing();
      checkControlMissing(); // mai due avvisi uguali
    });
    await expect(page.locator('[data-control-missing]')).toHaveCount(1);
    await expect(page.locator('[data-control-missing]')).toContainText('non ha ricevuto il Codice Stanza');

    await page.evaluate(async () => {
      // Stesso codice già in uso: nessuna riconnessione, basta che il messaggio arrivi.
      await handleFacilityControlMessage(await window.__signControl({ users: {}, groupCode: currentGroupCode, updatedAt: 4000 }));
    });
    await expect(page.locator('[data-control-missing]')).toHaveCount(0);
  });

  test('nessun avviso se il PC ha già ricevuto il codice in passato', async ({ page }) => {
    await loginBypass(page, 'struttura1');
    await page.evaluate(() => {
      activeFacilityId = 'struttura1';
      cacheControlOverride('struttura1', { users: {}, groupCode: 'codice-di-prova', updatedAt: 1 });
      ownControlSeenThisSession = false;
      checkControlMissing();
    });
    await expect(page.locator('[data-control-missing]')).toHaveCount(0);
  });

  test('la copia identica ripubblicata non riannuncia un profilo invariato', async ({ page }) => {
    await loginBypass(page, 'struttura1');
    await setupSigner(page);
    await page.evaluate(async () => {
      currentGroupCode = 'codice-di-prova';
      S.currentDoctor = { username: 'medico.prova', name: DOCTORS.struttura1.name };
      document.getElementById('toast-box').innerHTML = '';
      await handleFacilityControlMessage(await window.__signControl({
        users: { 'medico.prova': { name: DOCTORS.struttura1.name, spec: DOCTORS.struttura1.spec } },
        groupCode: 'codice-di-prova', updatedAt: 6000,
      }));
    });
    await expect(page.locator('#toast-box')).not.toContainText('profilo è stato aggiornato');
  });

  test('il pannello admin non torna a una copia più vecchia', async ({ page }) => {
    await page.goto('/?admin=1');
    await setupSigner(page);
    const state = await page.evaluate(async () => {
      adminControlState = { struttura1: { users: {}, groupCode: 'codice-nuovo-di-prova', updatedAt: 2000 } };
      currentGroupCode = 'codice-nuovo-di-prova';
      await handleAdminControlMessageForDisplay(ADMIN_CONTROL_TOPIC + 'struttura1',
        await window.__signControl({ users: {}, groupCode: 'codice-vecchio-di-prova', updatedAt: 1000 }));
      return { at: adminControlState.struttura1.updatedAt, code: currentGroupCode };
    });
    expect(state.at).toBe(2000);
    expect(state.code).toBe('codice-nuovo-di-prova');
  });

  test('la data di un nuovo comando admin non scende mai sotto l\'ultima nota', async ({ page }) => {
    await page.goto('/?admin=1');
    await setupSigner(page);
    const r = await page.evaluate(async () => {
      const future = Date.now() + 3 * 60 * 60 * 1000; // comando precedente fatto con orologio avanti di 3 ore
      const normal = nextAdminControlUpdatedAt('struttura1', null);
      // Visto sul broker dal pannello: diventa la soglia anche dopo un ricaricamento.
      adminControlState = {};
      await handleAdminControlMessageForDisplay(ADMIN_CONTROL_TOPIC + 'struttura1',
        await window.__signControl({ users: {}, updatedAt: future }));
      adminControlState = {}; // messaggio sparito dal broker / pannello ricaricato
      const afterFuture = nextAdminControlUpdatedAt('struttura1', null);
      const fromBase = nextAdminControlUpdatedAt('struttura2', { updatedAt: future + 50 });
      return { normal, now: Date.now(), future, afterFuture, fromBase };
    });
    expect(Math.abs(r.normal - r.now)).toBeLessThan(5000);
    expect(r.afterFuture).toBe(r.future + 1);
    expect(r.fromBase).toBe(r.future + 51);
  });
});
