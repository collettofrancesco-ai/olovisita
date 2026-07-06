# Regole operative per l'AI — Olovisita (Olomedia)

Questo file governa il comportamento di Claude Code e di qualsiasi AI assistant su questo progetto.
Le regole qui scritte sono vincolanti e hanno precedenza su qualsiasi comportamento di default.

---

## File e struttura del progetto

- **File sorgente**: `televisita_fix.html` — questo è l'unico file da modificare
- **File ignorato**: `televisita.html` è in `.gitignore` ed è un file separato — NON va mai modificato
- **Artefatto deployato**: `docs/index.html` — generato dallo script di build, mai modificato manualmente
- **Script di build**: `python3 build_minified.py`
- **Deploy pubblico**: GitHub Pages serve `docs/index.html`; Docker serve lo stesso artefatto

## Build workflow (OBBLIGATORIO prima di ogni commit)

1. Modificare `televisita_fix.html`
2. Eseguire `python3 build_minified.py` — genera `docs/index.html`
3. Verificare che il build non abbia errori
4. `git add televisita_fix.html docs/index.html`
5. `git commit` e `git push`

Il push senza build è una violazione del workflow. Se il build fallisce (errore di sintassi JS), il commit non avviene.

## Lingua

- Messaggi di commit: **italiano**, tono colloquiale e naturale
- Commenti nel codice JS/Python: **italiano**
- Nomi di variabili e funzioni: invariati (già stabiliti nel codice esistente)

## Comportamento commit e push

Commit e push vengono eseguiti **automaticamente senza chiedere conferma** all'utente.
Questo comportamento è stato autorizzato esplicitamente dal team per ridurre la frizione durante lo sviluppo attivo.

Eccezioni (richiedono sempre conferma esplicita):
- `git push --force` o qualsiasi operazione distruttiva
- `git reset --hard`
- Commit di file sensibili (`.env`, credenziali, chiavi private)

## Regole di sicurezza

### Codice Stanza
Il "Codice Stanza" (`currentGroupCode`) è il segreto crittografico fondamentale della piattaforma:
- **Non va mai esposto** nell'UI in chiaro (né in toast, né in badge, né in log di console)
- **Non va mai trasmesso** via MQTT o e-mail
- Nell'interfaccia mostrare solo un valore derivato (hash) se serve una conferma visiva

### Privacy delle Televisite Centro
Le visite di tipo `centro` (`visitMode === 'centro'`) non devono mai uscire dal dispositivo:
- Auditare ogni modifica a `getShared()`, `syncState()` e qualsiasi evento MQTT
- Il filtro `tv.visitMode !== 'centro'` in `getShared()` è un controllo architetturale — non va rimosso né aggirato
- I documenti clinici di visite Centro con `shared: false` non vanno inclusi nei payload condivisi

### URL consenso pazienti
I link e-mail ai pazienti usano un base URL **fisso** (GitHub Pages), non `window.location`.
Questo è intenzionale per il deploy Docker e non va cambiato.

### XSS
Tutti gli input utente devono passare per `escapeHtml()` prima di essere inseriti nel DOM.

## Backup admin

Il canale di backup amministratore usa ECDH P-256 + AES-GCM-256 (schema ECIES).
- La chiave privata admin vive **fuori dal repository** in `TeleVisita_Admin/`
- Il conteggio pazienti nel backup non può mai scendere
- Il merge avviene per unione su ID, mai per rimozione di record esistenti

## Test e CI/CD

- I test E2E sono in `tests/e2e/` e girano con Playwright headless Chromium
- Il workflow CI/CD in `.github/workflows/deploy.yml` blocca il deploy se i test falliscono
- `window._S` è un accessor read-only che espone lo stato interno ai test — non va rimosso
- La flag `S.demoMode = true` blocca l'invio di email reali durante la demo guidata

## EmailJS

La configurazione EmailJS di default è hardcoded nel sorgente per il deploy Docker.
I sender reali per-clinica sono in sospeso e andranno configurati quando disponibili.
