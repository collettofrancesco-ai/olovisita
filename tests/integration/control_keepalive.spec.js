// @ts-check
const { test, expect } = require('@playwright/test');

// Rinnovo del canale di controllo dalle strutture (runControlKeepalive) contro il broker vero,
// ma SEMPRE su un topic casuale isolato con ?admin_test_topic (mai il canale reale, §11).
// Messaggi firmati con una chiave di prova generata nel browser; alla fine i messaggi
// conservati di prova vengono cancellati.

async function apriPagina(browser, base) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/?admin_test_topic=' + encodeURIComponent(base));
  return page;
}

async function installaChiave(page, jwkPriv, jwkPub) {
  await page.evaluate(async ({ jwkPriv, jwkPub }) => {
    const priv = await crypto.subtle.importKey('jwk', jwkPriv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    cachedAdminControlPublicKey = await crypto.subtle.importKey('jwk', jwkPub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    window.__signControl = async (obj) => {
      const data = JSON.stringify(obj);
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, new TextEncoder().encode(data));
      return JSON.stringify({ data, signature: arrayBufferToBase64(sig) });
    };
  }, { jwkPriv, jwkPub });
}

async function conservaCopia(page, role, updatedAt) {
  return page.evaluate(async ({ role, updatedAt }) => {
    const payload = { users: {}, groupCode: 'codice-di-prova', updatedAt };
    const raw = await window.__signControl(payload);
    cacheControlEnvelope(role, raw, payload);
    return raw;
  }, { role, updatedAt });
}

async function eseguiRinnovo(page) {
  await page.evaluate(() => new Promise((resolve) => {
    runControlKeepalive();
    const check = () => controlKeepaliveInFlight ? setTimeout(check, 200) : resolve(true);
    setTimeout(check, 200);
  }));
}

async function leggiConservato(page, role) {
  return page.evaluate((role) => new Promise((resolve) => {
    const c = mqtt.connect(MQTT_BROKERS[0].url, { clean: true, connectTimeout: 8000, reconnectPeriod: 0 });
    let value = null;
    c.on('message', (_t, m) => { if (m && m.length) value = m.toString(); });
    c.on('connect', () => c.subscribe(ADMIN_CONTROL_TOPIC + role, { qos: 1 }, () => {
      setTimeout(() => { c.end(true); resolve(value); }, 4000);
    }));
    c.on('error', () => resolve(null));
  }), role);
}

async function cancellaConservati(page) {
  await page.evaluate(() => new Promise((resolve) => {
    const c = mqtt.connect(MQTT_BROKERS[0].url, { clean: true, connectTimeout: 8000, reconnectPeriod: 0 });
    c.on('connect', () => {
      let n = 0;
      ['struttura1', 'struttura2'].forEach(r => c.publish(ADMIN_CONTROL_TOPIC + r, '', { qos: 1, retain: true }, () => {
        if (++n === 2) { c.end(true); resolve(true); }
      }));
    });
    c.on('error', () => resolve(false));
  }));
}

test('le strutture rimettono sul broker il Codice Stanza sparito, senza mai tornare indietro', async ({ browser }) => {
  test.setTimeout(120000);
  const base = 'olovisita-test/keepalive-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  const pcA = await apriPagina(browser, base);
  // Coppia di chiavi di prova condivisa fra i due "PC" (fa le veci della chiave admin).
  const keys = await pcA.evaluate(async () => {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    return { priv: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: await crypto.subtle.exportKey('jwk', kp.publicKey) };
  });
  await installaChiave(pcA, keys.priv, keys.pub);

  try {
    // 1) Broker vuoto: il PC rimette la sua copia, byte per byte.
    const t0 = Date.now();
    const copia1 = await conservaCopia(pcA, 'struttura1', t0);
    await eseguiRinnovo(pcA);
    expect(await leggiConservato(pcA, 'struttura1')).toBe(copia1);

    // 2) Sul broker c'è una copia più vecchia di quella del PC: viene sostituita.
    const copia2 = await conservaCopia(pcA, 'struttura1', t0 + 1000);
    await eseguiRinnovo(pcA);
    expect(await leggiConservato(pcA, 'struttura1')).toBe(copia2);

    // 3) Un altro PC rimasto indietro (copia più vecchia) NON sovrascrive quella più recente,
    //    e anzi impara quella nuova dal broker.
    const pcB = await apriPagina(browser, base);
    await installaChiave(pcB, keys.priv, keys.pub);
    await conservaCopia(pcB, 'struttura1', t0 - 5000);
    await eseguiRinnovo(pcB);
    expect(await leggiConservato(pcB, 'struttura1')).toBe(copia2);
    const imparata = await pcB.evaluate(() => readCachedControlEnvelope('struttura1'));
    expect(imparata && imparata.raw).toBe(copia2);

    // 4) Anche la copia dell'ALTRA struttura viene tenuta viva.
    const copiaAltra = await conservaCopia(pcA, 'struttura2', t0);
    await eseguiRinnovo(pcA);
    expect(await leggiConservato(pcA, 'struttura2')).toBe(copiaAltra);
  } finally {
    await cancellaConservati(pcA);
  }
});
