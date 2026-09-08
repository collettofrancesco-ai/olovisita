// @ts-check
const { test, expect } = require('@playwright/test');
const { loginBypass } = require('./helpers');

// Regressioni ad alto impatto: controlli piccoli e stabili sugli invarianti di privacy,
// autenticazione e consenso. Non simulano servizi esterni e non toccano i topic reali.

test.describe('Confini di privacy delle visite Centro', () => {
  test('la lista visibile mostra una visita Centro soltanto alla struttura che l’ha creata', async ({ page }) => {
    await loginBypass(page, 'struttura1');
    await page.evaluate(() => {
      window._S.televisite = [
        { id: 'centro-s1', patient: 'Privato S1', visitMode: 'centro', scheduledBy: 'struttura1', date: '2026-09-09', time: '09:00' },
        { id: 'centro-s2', patient: 'Privato S2', visitMode: 'centro', scheduledBy: 'struttura2', date: '2026-09-10', time: '09:00' },
        { id: 'network', patient: 'Condiviso', visitMode: 'network', scheduledBy: 'struttura2', date: '2026-09-08', time: '09:00' }
      ];
    });

    expect(await page.evaluate(() => visibleTelevisite().map(v => v.id))).toEqual(['centro-s1', 'network']);
  });

  test('un documento Centro esce in getShared solo dopo condivisione esplicita', async ({ page }) => {
    await loginBypass(page, 'struttura1');
    const ids = await page.evaluate(() => {
      window._S.televisite = [{ id: 'tv-centro', patient: 'Privato', visitMode: 'centro', scheduledBy: 'struttura1' }];
      window._S.docs = [
        { id: 'doc-privato', tvId: 'tv-centro', by: 'struttura1', shared: false, base64Data: 'SEGRETO' },
        { id: 'doc-condiviso', tvId: 'tv-centro', by: 'struttura1', shared: true, base64Data: 'DATI' }
      ];
      return getShared().docs.map(d => ({ id: d.id, base64Data: d.base64Data }));
    });

    expect(ids).toEqual([{ id: 'doc-condiviso', base64Data: null }]);
  });

  test('quick-share resta bloccato anche se richiamato direttamente su una visita Centro', async ({ page }) => {
    await loginBypass(page, 'struttura1');
    const result = await page.evaluate(() => {
      window._S.televisite = [{ id: 'tv-centro-call', patient: 'Privato', visitMode: 'centro' }];
      window._S.docs = [];
      window._S.activeTvId = 'tv-centro-call';
      const fakeInput = { files: [new File(['x'], 'referto.pdf', { type: 'application/pdf' })], value: 'selezionato' };
      quickShareFromCall(fakeInput);
      return { docs: window._S.docs.length, inputValue: fakeInput.value };
    });

    expect(result).toEqual({ docs: 0, inputValue: '' });
  });
});

test.describe('Validazione dei backup importati', () => {
  test('scarta identificativi manipolati che potrebbero finire nel DOM', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(() => sanitizeImportedVisit({
      id: `x' onclick='window.__importXss=true`, patient: 'Paziente', status: 'programmata', date: '2026-09-08', time: '10:30'
    }));
    expect(result).toBeNull();
  });

  test('normalizza stato, data e ora fuori formato senza perdere il record valido', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(() => sanitizeImportedVisit({
      id: 'visita_valida-1', patient: 'Paziente', status: '<img>', date: '08/09/2026', time: '99:99'
    }));
    expect(result).toMatchObject({ id: 'visita_valida-1', status: 'programmata', date: '', time: '' });
  });
});

test.describe('Autenticazione del canale amministratore', () => {
  test('accetta un HMAC autentico e rifiuta lo stesso payload dopo una modifica', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async () => {
      const payload = { role: 'struttura1', ts: 12345, shared: { televisite: [] } };
      const signed = { ...payload, adminChannelHmac: await computeAdminChannelHmac(payload) };
      return {
        authentic: await verifyAdminChannelHmac(signed),
        tampered: await verifyAdminChannelHmac({ ...signed, role: 'struttura2' }),
        missing: await verifyAdminChannelHmac(payload)
      };
    });
    expect(result).toEqual({ authentic: true, tampered: false, missing: false });
  });
});

test.describe('Consenso e collegamenti paziente', () => {
  test('il consenso è solo italiano in IT e francese più arabo in FR', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(() => {
      currentLang = 'it';
      const it = getConsentLangs();
      currentLang = 'fr';
      const fr = getConsentLangs();
      return { it, fr };
    });
    expect(result).toEqual({ it: ['it'], fr: ['fr', 'ar'] });
  });

  test('il link consenso usa la base pubblica e non espone il Codice Stanza', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async () => {
      currentLang = 'fr';
      currentTopicId = 'topic-test';
      const url = await buildPatientConsentUrl({ id: 'tv-link-test' }, 'Nom Patient', 'patient@example.test');
      const parsed = new URL(url);
      return {
        originAndPath: parsed.origin + parsed.pathname,
        consent: parsed.searchParams.get('consent'),
        lang: parsed.searchParams.get('lang'),
        hasLegacyRoom: parsed.searchParams.has('room') || parsed.searchParams.has('code'),
        leaksGroupCode: url.includes(currentGroupCode),
        vkeyLength: (parsed.searchParams.get('vkey') || '').length
      };
    });
    expect(result).toEqual({
      originAndPath: 'https://collettofrancesco-ai.github.io/olovisita/',
      consent: '1',
      lang: 'fr',
      hasLegacyRoom: false,
      leaksGroupCode: false,
      vkeyLength: 64
    });
  });
});

test.describe('Persistenza della sessione', () => {
  test('una sessione riferita a un utente inesistente non viene ripristinata', async ({ page }) => {
    await page.goto('/');
    const restored = await page.evaluate(() => {
      localStorage.setItem('tv_session', JSON.stringify({ role: 'struttura1', username: 'utente-inesistente' }));
      return tryRestoreSession();
    });
    expect(restored).toBe(false);
    await expect(page.locator('#login-overlay')).toBeVisible();
  });
});

test.describe('Gestione documenti', () => {
  test('senza una visita selezionata mostra un solo invito e nasconde i controlli inutilizzabili', async ({ page }) => {
    await loginBypass(page, 'struttura1');
    await page.evaluate(() => {
      window._S.activeTvId = null;
      renderDocs();
    });

    await expect(page.locator('#patient-hint-banner')).toBeVisible();
    await expect(page.locator('#doc-filters')).toBeHidden();
    await expect(page.locator('#upload-zone-wrap')).toBeHidden();
    await expect(page.locator('#doc-list')).toBeHidden();
  });

  test('con una visita selezionata rende evidente il paziente associato al caricamento', async ({ page }) => {
    await loginBypass(page, 'struttura1');
    await page.evaluate(() => {
      window._S.televisite = [{
        id: 'tv-documenti', patient: 'Maria Test', visitMode: 'centro', scheduledBy: 'struttura1',
        date: '2026-09-08', time: '10:30'
      }];
      window._S.activeTvId = 'tv-documenti';
      renderDocs();
    });

    await expect(page.locator('#doc-patient-context')).toBeVisible();
    await expect(page.locator('#doc-context-patient')).toHaveText('Maria Test');
    await expect(page.locator('#doc-context-meta')).toContainText('08/09/2026 · 10:30');
    await expect(page.locator('#doc-filters')).toBeVisible();
    await expect(page.locator('#upload-zone-wrap')).toBeVisible();
  });
});

test.describe('Calendario, layout e colori di stato', () => {
  test('su desktop calendario e lista delle visite sono affiancati', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginBypass(page, 'struttura1');
    await page.evaluate(() => renderVisits());

    const layout = await page.locator('#p-s1 .visit-planner').evaluate(el => {
      const columns = getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean);
      const calendarWidth = el.querySelector('.tv-calendar').getBoundingClientRect().width;
      return { columnCount: columns.length, calendarWidth };
    });

    expect(layout.columnCount).toBe(2);
    expect(layout.calendarWidth).toBeGreaterThanOrEqual(320);
  });

  test('su mobile calendario e lista tornano su una sola colonna senza uscire dallo schermo', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginBypass(page, 'struttura1');
    await page.evaluate(() => renderVisits());

    const layout = await page.locator('#p-s1 .visit-planner').evaluate(el => {
      const plannerRect = el.getBoundingClientRect();
      const calendarRect = el.querySelector('.tv-calendar').getBoundingClientRect();
      return {
        columnCount: getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length,
        calendarFits: calendarRect.width <= plannerRect.width + 1
      };
    });

    expect(layout).toEqual({ columnCount: 1, calendarFits: true });
  });

  test('selezionare un giorno mostra solo le visite di quella data e un solo comando Mostra tutte', async ({ page }) => {
    await loginBypass(page, 'struttura1');
    await page.evaluate(() => {
      calendarViewYear = 2026;
      calendarViewMonth = 8;
      calendarSelectedDate = null;
      window._S.televisite = [
        { id: 'cal-8', patient: 'Maria Otto', visitMode: 'network', scheduledBy: 'struttura1', status: 'programmata', date: '2026-09-08', time: '10:00' },
        { id: 'cal-9', patient: 'Luigi Nove', visitMode: 'network', scheduledBy: 'struttura1', status: 'programmata', date: '2026-09-09', time: '11:00' }
      ];
      renderVisits();
    });

    await page.locator('#cal-s1 .tv-cal-day').filter({ hasText: /^8$/ }).click();
    await expect(page.locator('#vlist-s1')).toContainText('Maria Otto');
    await expect(page.locator('#vlist-s1')).not.toContainText('Luigi Nove');
    await expect(page.locator('#cal-s1 .tv-cal-footer button')).toHaveCount(1);

    await page.locator('#cal-s1 .tv-cal-footer button').click();
    await expect(page.locator('#vlist-s1')).toContainText('Luigi Nove');
  });

  test('gli stati positivi, di attenzione e di errore usano famiglie cromatiche distinte', async ({ page }) => {
    await page.goto('/');
    const palette = await page.evaluate(() => ({
      accepted: statusInfo('accettata'),
      completed: statusInfo('completata'),
      warning: statusInfo('in-corso'),
      waiting: statusInfo('waiting'),
      rejected: statusInfo('rifiutata'),
      absent: statusInfo('non_presentato'),
      cancelled: statusInfo('annullata'),
      planned: statusInfo('programmata')
    }));

    expect(palette.accepted.color).toBe(palette.completed.color);
    expect(palette.warning.color).toBe(palette.waiting.color);
    expect(palette.rejected.color).toBe(palette.absent.color);
    expect(new Set([
      palette.accepted.color, palette.warning.color, palette.rejected.color,
      palette.cancelled.color, palette.planned.color
    ]).size).toBe(5);
  });
});
