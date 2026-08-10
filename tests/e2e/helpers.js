// @ts-check
const { expect } = require('@playwright/test');

/**
 * Bypassa la schermata di login attivando direttamente il cruscotto.
 * Usato da tutti i test che testano funzionalità del dashboard, non il login stesso.
 * @param {import('@playwright/test').Page} page
 * @param {'struttura1'|'struttura2'} role
 */
async function loginBypass(page, role = 'struttura1') {
  await page.goto('/');
  // Blocca le chiamate EmailJS e MQTT reali prima che la pagina le avvii
  await page.route('**/*emailjs*/**', route => route.abort());
  await page.route('**/*.mqtt*/**', route => route.abort());
  // Nasconde l'overlay di login ed entra nel cruscotto come se il login fosse avvenuto.
  // isDoctorAuthenticated (non su window: è un "let" a livello di script, visibile come
  // identificatore libero nello stesso realm, non come proprietà di window) va impostato qui
  // perché renderAll() ora rifiuta di disegnare qualunque cosa finché non è vero — altrimenti
  // ogni test che passa da questo bypass vedrebbe liste/badge sempre vuoti.
  await page.evaluate((r) => {
    document.getElementById('login-overlay').style.display = 'none';
    window.switchRole(r);
    isDoctorAuthenticated = true;
  }, role);
  // Verifica che il cruscotto sia effettivamente visibile
  await expect(page.locator('#role-badge')).toBeVisible();
}

/**
 * Restituisce la data di oggi nel formato YYYY-MM-DD (usato dai campi <input type="date">).
 * @returns {string}
 */
function todayStr() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Restituisce un orario libero nel futuro (es. 23:45) per evitare conflitti con
 * altre televisite create dai test precedenti nella stessa sessione.
 * @param {number} offsetMinutes minuti dall'ora corrente (default 90)
 * @returns {string} formato HH:MM
 */
function futureTime(offsetMinutes = 90) {
  const d = new Date(Date.now() + offsetMinutes * 60000);
  return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
}

module.exports = { loginBypass, todayStr, futureTime };
