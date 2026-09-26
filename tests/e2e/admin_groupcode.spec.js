// Verifica del riscontro admin sulla rotazione senza connessioni MQTT reali.
const { test, expect } = require('@playwright/test');

async function openAdminStatus(page) {
  await page.goto('/?admin=1');
  await page.evaluate(() => {
    adminControlState = {
      struttura1: { users: {}, groupCode: 'codice-di-test-struttura', updatedAt: Date.now() },
      struttura2: { users: {}, groupCode: 'codice-di-test-struttura', updatedAt: Date.now() }
    };
    adminGroupCodeRejectedRoles.clear();
  });
}

test.describe('Conferma rotazione Codice Stanza nel pannello admin', () => {
  test('non conferma la rotazione usando backup precedenti al comando', async ({ page }) => {
    await openAdminStatus(page);
    await page.evaluate(async () => {
      currentGroupCode = 'codice-di-test-struttura';
      const topic = await deriveTopicId(currentGroupCode);
      adminGroupCodeRotationPendingAt = Date.now();
      adminReceivedBackups.struttura1 = { ts: adminGroupCodeRotationPendingAt - 1000, facility: 'Centro Tunisia', data: { networkTopicId: topic } };
      adminReceivedBackups.struttura2 = { ts: adminGroupCodeRotationPendingAt - 1000, facility: 'Ospedale Cervello', data: { networkTopicId: topic } };
      await renderAdminGroupCodeStatus();
    });

    await expect(page.locator('#admin-groupcode-status')).toContainText('Comando inviato; attendo backup aggiornati');
    await expect(page.locator('#admin-groupcode-status')).not.toContainText('Allineato e confermato');
  });

  test('conferma solo dopo backup autentici e successivi alla rotazione su topic atteso', async ({ page }) => {
    await openAdminStatus(page);
    await page.evaluate(async () => {
      currentGroupCode = 'codice-di-test-struttura';
      const now = Date.now();
      const topic = await deriveTopicId(currentGroupCode);
      adminGroupCodeRotationPendingAt = now - 1000;
      adminReceivedBackups.struttura1 = { ts: now, facility: 'Centro Tunisia', data: { networkTopicId: topic } };
      adminReceivedBackups.struttura2 = { ts: now, facility: 'Ospedale Cervello', data: { networkTopicId: topic } };
      await renderAdminGroupCodeStatus();
    });

    await expect(page.locator('#admin-groupcode-status')).toContainText('Codice applicato e confermato da backup autentico');
    await expect(page.locator('#admin-groupcode-status')).toContainText('Allineato e confermato');
  });

  test('segnala i topic diversi riportati dai due backup', async ({ page }) => {
    await openAdminStatus(page);
    await page.evaluate(async () => {
      currentGroupCode = 'codice-di-test-struttura';
      adminReceivedBackups.struttura1 = { ts: Date.now(), facility: 'Centro Tunisia', data: { networkTopicId: 'topic-uno' } };
      adminReceivedBackups.struttura2 = { ts: Date.now(), facility: 'Ospedale Cervello', data: { networkTopicId: 'topic-due' } };
      await renderAdminGroupCodeStatus();
    });

    await expect(page.locator('#admin-groupcode-status')).toContainText('DAVVERO su canali diversi');
  });

  test('mostra una sola segnalazione inline per i backup HMAC non verificabili', async ({ page }) => {
    await openAdminStatus(page);
    await page.evaluate(async () => {
      adminGroupCodeRejectedRoles.add('struttura2');
      await renderAdminGroupCodeStatus();
      await renderAdminGroupCodeStatus();
    });

    await expect(page.locator('#admin-groupcode-status')).toContainText('Ospedale Vincenzo Cervello');
    await expect(page.locator('#admin-groupcode-status')).toContainText('Backup non verificabile');
    await expect(page.locator('#toast-box .toast')).toHaveCount(0);
  });
});
