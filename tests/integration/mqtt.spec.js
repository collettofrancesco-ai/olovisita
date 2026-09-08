// @ts-check
const { test, expect } = require('@playwright/test');

// Testa il percorso reale browser → EMQX → browser. Non usa initMQTT(), perché quel
// client sottoscrive anche i canali amministrativi di produzione: qui colleghiamo solo
// il topic casuale della singola esecuzione, senza retain e senza dati sanitari reali.

async function preparaStruttura(browser, role, code, runId) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.evaluate(async ({ role, code }) => {
    document.getElementById('login-overlay').style.display = 'none';
    S.role = role;
    activeFacilityId = role;
    isDoctorAuthenticated = true;
    currentGroupCode = code;
    cachedCryptoKey = null;
    currentTopicId = await deriveTopicId(code);
    renderAll();
  }, { role, code });

  const topic = await page.evaluate(() => MQTT_TOPIC_BASE + currentTopicId);
  await page.evaluate(({ role, runId, topic }) => new Promise((resolve, reject) => {
    if (typeof mqtt === 'undefined') return reject(new Error('Libreria MQTT non caricata'));
    const client = mqtt.connect(MQTT_BROKERS[0].url, {
      clean: true,
      connectTimeout: 8000,
      protocolVersion: 4,
      clientId: `e2e_${role}_${runId}`
    });
    window.__mqttIntegrationClient = client;
    client.on('error', reject);
    client.on('connect', () => {
      client.subscribe(topic, { qos: 1 }, err => err ? reject(err) : resolve(true));
    });
    client.on('message', async (_topic, raw) => {
      try {
        const envelope = JSON.parse(raw.toString());
        if (envelope.sender === activeFacilityId) return;
        const decrypted = await decryptPayload(envelope, currentGroupCode);
        if (decrypted) handleIncomingSync(decrypted);
      } catch (_) { }
    });
  }), { role, runId, topic });

  return { context, page, topic };
}

async function pubblica(page, payload) {
  await page.evaluate(async ({ payload }) => {
    const encrypted = await encryptPayload(payload, currentGroupCode);
    const envelope = {
      sender: activeFacilityId,
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext
    };
    const topic = MQTT_TOPIC_BASE + currentTopicId;
    await new Promise((resolve, reject) => {
      // retain:false è tassativo: il broker non conserva nemmeno i dati sintetici.
      window.__mqttIntegrationClient.publish(topic, JSON.stringify(envelope), { qos: 1, retain: false }, err => {
        if (err) reject(err); else resolve(true);
      });
    });
  }, { payload });
}

async function chiudiStruttura(page, context) {
  await page.evaluate(() => new Promise(resolve => {
    const client = window.__mqttIntegrationClient;
    if (!client) return resolve(true);
    client.end(true, {}, () => resolve(true));
    setTimeout(() => resolve(true), 1000);
  })).catch(() => {});
  await context.close();
}

test('una visita Network passa da Struttura 1 a 2 e l’accettazione torna alla Struttura 1', async ({ browser }) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const code = `mqtt-e2e-${runId}-${Math.random().toString(36).slice(2)}`;
  let s1;
  let s2;

  try {
    s1 = await preparaStruttura(browser, 'struttura1', code, runId);
    s2 = await preparaStruttura(browser, 'struttura2', code, runId);
    expect(s1.topic).toBe(s2.topic);

    const outgoing = await s1.page.evaluate(() => {
      S.televisite = [
        { id: 'mqtt-network-sintetica', patient: 'PAZIENTE TEST MQTT', visitMode: 'network', scheduledBy: 'struttura1', status: 'programmata', date: '2099-01-01', time: '10:00' },
        { id: 'mqtt-centro-sintetica', patient: 'PRIVATO TEST MQTT', visitMode: 'centro', scheduledBy: 'struttura1', status: 'accettata', date: '2099-01-01', time: '11:00' }
      ];
      return getShared();
    });
    expect(outgoing.televisite.map(v => v.id)).toEqual(['mqtt-network-sintetica']);

    await pubblica(s1.page, { shared: outgoing, event: { id: `ev_${runId}`, kind: 'visit_scheduled' } });
    await expect.poll(() => s2.page.evaluate(() => S.televisite.map(v => v.id)), { timeout: 10000 })
      .toContain('mqtt-network-sintetica');
    expect(await s2.page.evaluate(() => S.televisite.some(v => v.id === 'mqtt-centro-sintetica'))).toBe(false);

    const accepted = await s2.page.evaluate(() => {
      const tv = S.televisite.find(v => v.id === 'mqtt-network-sintetica');
      tv.status = 'accettata';
      return getShared();
    });
    await pubblica(s2.page, { shared: accepted, event: { id: `ev_accept_${runId}`, kind: 'visit_accepted' } });
    await expect.poll(() => s1.page.evaluate(() => S.televisite.find(v => v.id === 'mqtt-network-sintetica')?.status), { timeout: 10000 })
      .toBe('accettata');
  } finally {
    if (s1) await chiudiStruttura(s1.page, s1.context);
    if (s2) await chiudiStruttura(s2.page, s2.context);
  }
});

test('stati concorrenti si uniscono per id e un payload con chiave errata viene ignorato', async ({ browser }) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const code = `mqtt-merge-${runId}-${Math.random().toString(36).slice(2)}`;
  let s1;
  let s2;
  try {
    s1 = await preparaStruttura(browser, 'struttura1', code, runId);
    s2 = await preparaStruttura(browser, 'struttura2', code, runId);

    const statoA = { shared:{ televisite:[{ id:'net-a', patient:'TEST A', visitMode:'network', scheduledBy:'struttura1', status:'programmata' }], docs:[], immReq:null, immRoom:null, immReqSender:null }, event:null };
    const statoB = { shared:{ televisite:[{ id:'net-b', patient:'TEST B', visitMode:'network', scheduledBy:'struttura2', status:'programmata' }], docs:[], immReq:null, immRoom:null, immReqSender:null }, event:null };
    await s1.page.evaluate(payload => { S.televisite = payload.shared.televisite.slice(); }, statoA);
    await s2.page.evaluate(payload => { S.televisite = payload.shared.televisite.slice(); }, statoB);
    await pubblica(s1.page, statoA);
    await pubblica(s2.page, statoB);
    await expect.poll(() => s1.page.evaluate(() => S.televisite.map(v => v.id).sort()), { timeout:10000 }).toEqual(['net-a', 'net-b']);
    await expect.poll(() => s2.page.evaluate(() => S.televisite.map(v => v.id).sort()), { timeout:10000 }).toEqual(['net-a', 'net-b']);

    await s1.page.evaluate(async () => {
      const wrong = await encryptPayload({ shared:{ televisite:[{ id:'intruso', patient:'TEST', visitMode:'network' }], docs:[] } }, 'chiave-errata-isolata');
      const envelope = { sender:'struttura1', iv:wrong.iv, ciphertext:wrong.ciphertext };
      await new Promise((resolve, reject) => window.__mqttIntegrationClient.publish(MQTT_TOPIC_BASE + currentTopicId, JSON.stringify(envelope), { qos:1, retain:false }, err => err ? reject(err) : resolve()));
    });
    await s2.page.waitForTimeout(1200);
    expect(await s2.page.evaluate(() => S.televisite.some(v => v.id === 'intruso'))).toBe(false);
  } finally {
    if (s1) await chiudiStruttura(s1.page, s1.context);
    if (s2) await chiudiStruttura(s2.page, s2.context);
  }
});
