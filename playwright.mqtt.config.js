// Suite di integrazione separata: usa davvero il broker MQTT pubblico, ma soltanto
// con topic casuali non-retained e dati sintetici. Non fa parte dei test bloccanti
// del deploy, perché un disservizio esterno di EMQX non deve fermare una release.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/integration',
  timeout: 45000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  webServer: {
    command: 'python3 -m http.server 4322 --directory docs',
    url: 'http://localhost:4322',
    reuseExistingServer: true,
    timeout: 15000,
  },
  use: {
    baseURL: 'http://localhost:4322',
    headless: true,
    serviceWorkers: 'block',
    ...devices['Desktop Chrome'],
  },
});
