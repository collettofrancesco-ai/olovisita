// @ts-check
const { test, expect } = require('@playwright/test');
const { loginBypass, todayStr, futureTime } = require('./helpers');

// Test dedicati alle misure di sicurezza descritte nel Capitolo 3 del documento
// manuale/Valutazione_Sicurezza_GDPR_Olovisita.html: a differenza dei test funzionali degli
// altri file (che verificano che le cose funzionino), questi verificano che specifiche difese
// siano davvero attive, così un regresso su una di esse fa fallire la suite invece di passare
// inosservato.

test.describe('Prevenzione XSS', () => {
  test('un nome paziente con markup viene sempre escapato, mai eseguito', async ({ page }) => {
    await loginBypass(page, 'struttura1');

    const payload = '<img src=x onerror="window.__xss=true">';
    await page.fill('#f-patient', payload);
    await page.fill('#f-email', 'xss@test.invalid');
    await page.selectOption('#f-visit-mode', 'network');
    await page.fill('#f-date', todayStr());
    await page.fill('#f-time', futureTime(200));
    await page.locator('#sched-form button[type="submit"]').click();

    // Se escapeHtml() non fosse applicato, l'onerror scatterebbe appena l'immagine (inesistente)
    // viene inserita nel DOM: questo flag non deve MAI diventare true.
    const xssTriggered = await page.evaluate(() => window.__xss === true);
    expect(xssTriggered).toBe(false);

    const listHtml = await page.locator('#vlist-s1').innerHTML();
    expect(listHtml).not.toContain('<img src=x onerror=');
    expect(listHtml).toContain('&lt;img src=x onerror=');
  });
});

test.describe('Isolamento visite Centro (getShared)', () => {
  test('getShared() esclude le televisite Centro dal payload di sincronizzazione', async ({ page }) => {
    await loginBypass(page, 'struttura1');

    await page.evaluate(() => {
      window._S.televisite.push({ id: 'sec-centro', patient: 'Paziente Privato Centro', visitMode: 'centro', status: 'accettata' });
      window._S.televisite.push({ id: 'sec-network', patient: 'Paziente Network Test', visitMode: 'network', status: 'programmata' });
    });

    const sharedPatients = await page.evaluate(() => window.getShared().televisite.map(t => t.patient));
    expect(sharedPatients).not.toContain('Paziente Privato Centro');
    expect(sharedPatients).toContain('Paziente Network Test');
  });
});

test.describe('Guardia pre-login', () => {
  test('nessun dato paziente viene mai renderizzato prima di un login reale', async ({ page }) => {
    await page.goto('/');
    // NIENTE loginBypass qui: la pagina resta sulla schermata di login, isDoctorAuthenticated
    // deve restare false. Inserisce dati direttamente nello stato e prova a forzare un render,
    // esattamente lo scenario della falla critica corretta in produzione (vedi memoria
    // project_pre_login_data_leak).
    await page.evaluate(() => {
      window._S.televisite.push({ id: 'prelogin', patient: 'Paziente Segreto Pre-Login', status: 'programmata', visitMode: 'network' });
      window.renderAll();
    });

    await expect(page.locator('#login-overlay')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Paziente Segreto Pre-Login');
  });
});

test.describe('Rate limiting login', () => {
  test('dopo 3 tentativi falliti il login viene bloccato temporaneamente', async ({ page }) => {
    await page.goto('/');
    await page.click('#card-facility-s1');
    const options = page.locator('#user-select option');
    const count = await options.count();
    expect(count).toBeGreaterThan(1);
    const val = await options.nth(1).getAttribute('value');
    await page.selectOption('#user-select', val);

    // submitLogin è asincrona (attende fino a 1.5s il canale di controllo prima di confrontare
    // la password, fail-open): un click non aspetta da solo che finisca, quindi ogni tentativo
    // va atteso esplicitamente prima del successivo, altrimenti i conteggi vanno in race.
    const errEl = page.locator('#login-error-msg');
    for (let i = 0; i < 3; i++) {
      await page.fill('#pwd-input', 'passwordSicuramenteSbagliata' + i);
      await errEl.evaluate(el => { el.textContent = ''; });
      await page.click('button[onclick="submitLogin()"]');
      await expect(errEl).not.toHaveText('', { timeout: 5000 });
    }
    // Il 4° tentativo (anche con la password giusta) deve trovare il blocco già attivo
    await errEl.evaluate(el => { el.textContent = ''; });
    await page.fill('#pwd-input', 'un altro tentativo qualsiasi');
    await page.click('button[onclick="submitLogin()"]');

    await expect(errEl).toContainText('Troppi tentativi', { timeout: 5000 });
  });
});

test.describe('Cifratura a riposo (localStorage)', () => {
  test('lo stato salvato in localStorage non è mai testo in chiaro leggibile', async ({ page }) => {
    await loginBypass(page, 'struttura1');

    await page.evaluate(() => {
      window._S.televisite.push({ id: 'enc-test', patient: 'Nome Paziente Da Non Trovare In Chiaro', status: 'programmata', visitMode: 'network' });
    });
    await page.evaluate(() => window.persistTvState(window.getSharedStateForStorage()));

    const raw = await page.evaluate(() => localStorage.getItem('tv_state'));
    expect(raw).toBeTruthy();
    expect(raw).not.toContain('Nome Paziente Da Non Trovare In Chiaro');

    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty('iv');
    expect(parsed).toHaveProperty('ciphertext');
  });
});

test.describe('Rafforzamento hash password', () => {
  test('l\'hash della password non è un semplice SHA-256, ma una derivazione a più iterazioni', async ({ page }) => {
    await page.goto('/');

    const result = await page.evaluate(async () => {
      const plainSha256 = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('unaPasswordDiProva123'))
        .then(buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join(''));
      const stretched = await window.computeStoredPasswordHash('unaPasswordDiProva123', 'utente.di.prova');
      return { plainSha256, stretched, format64hex: /^[0-9a-f]{64}$/.test(stretched) };
    });

    expect(result.format64hex).toBe(true);
    // Se fosse ancora un semplice SHA-256 della password, questo test intercetterebbe il regresso.
    expect(result.stretched).not.toBe(result.plainSha256);
  });
});

test.describe('Segreto dedicato ai link paziente (F-01)', () => {
  test('il link inviato al paziente non permette di risalire al segreto di rete reale', async ({ page }) => {
    await loginBypass(page, 'struttura1');

    const result = await page.evaluate(async () => {
      const secretA = await window.derivePatientVisitSecret('visita-A');
      const secretB = await window.derivePatientVisitSecret('visita-B');
      return {
        differsPerVisit: secretA !== secretB,
        // currentGroupCode è un "let" a livello di script, non una proprietà di window (come _S,
        // esposto apposta per i test): qui è visibile come identificatore libero perché
        // page.evaluate esegue nello stesso contesto globale della pagina, non in un sandbox.
        neverEqualsGroupCode: secretA !== currentGroupCode && secretB !== currentGroupCode,
        format64hex: /^[0-9a-f]{64}$/.test(secretA)
      };
    });

    expect(result.differsPerVisit).toBe(true);
    expect(result.neverEqualsGroupCode).toBe(true);
    expect(result.format64hex).toBe(true);
  });
});
