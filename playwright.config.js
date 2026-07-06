// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 20000,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],

  webServer: {
    // Serve la cartella docs/ (il build produzione) con il server HTTP built-in di Python —
    // zero dipendenze aggiuntive, funziona su qualsiasi macchina con Python 3.
    command: 'python3 -m http.server 4321 --directory docs',
    url: 'http://localhost:4321',
    reuseExistingServer: !process.env.CI,
    timeout: 15000,
  },

  use: {
    baseURL: 'http://localhost:4321',
    headless: true,
    // blocca tutte le richieste verso EmailJS e MQTT per non sporcare i dati reali durante i test
    serviceWorkers: 'block',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
