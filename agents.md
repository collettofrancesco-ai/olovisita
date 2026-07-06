# agents.md — Standard di sviluppo Olovisita

Questo documento descrive le regole architetturali e operative che governano lo sviluppo
della piattaforma Olovisita. Chiunque lavori su questo codebase — umano o tool automatico —
deve rispettarle senza eccezioni.

---

## Struttura del progetto

Il progetto separa nettamente il file di lavoro dall'artefatto deployato.
Questa separazione è intenzionale e non va mai aggirata.

| File | Ruolo |
|------|-------|
| `televisita_fix.html` | Sorgente di sviluppo — leggibile, commentato, versionato |
| `docs/index.html` | Artefatto di produzione — generato dallo script, mai modificato a mano |
| `build_minified.py` | Script deterministico che produce l'artefatto dal sorgente |

`televisita.html` esiste come file separato ed è in `.gitignore` — ignorarlo completamente.

## Workflow di build (tassativo)

Ogni modifica al sorgente segue questo workflow, senza scorciatoie:

```
1. Modifico televisita_fix.html
2. python3 build_minified.py        # produce docs/index.html
3. git add televisita_fix.html docs/index.html
4. git commit && git push
```

Se il build script restituisce un errore, il commit non avviene.
Un errore di sintassi JS viene catturato qui, non in produzione.

## Lingua

- Commit e commenti nel codice: **italiano**
- Tono: diretto, tecnico, niente verbosità

## Decisioni architetturali di sicurezza

Queste scelte sono state prese deliberatamente e documentate qui
perché non risultino "strane" a chi legge il codice per la prima volta.

### Il Codice Stanza non appare mai nell'UI

Il `currentGroupCode` è il segreto da cui deriva l'intera catena crittografica
(SHA-256 → chiave AES-GCM-256 per MQTT, SHA-256+"::topic" → nome topic MQTT).
Esporlo in chiaro — anche solo in un toast o in un badge — rompe il modello di sicurezza.
Nell'UI compare solo un valore derivato se serve una conferma visiva del canale attivo.

### Le Televisite Centro non escono mai dal dispositivo

`getShared()` filtra `tv.visitMode !== 'centro'` **prima** della cifratura.
Le visite interne a una struttura non raggiungono mai il broker MQTT, nemmeno cifrate.
Questo è un controllo architetturale, non di interfaccia — non va rimosso né spostato.
Ogni modifica a `syncState()` o `getShared()` richiede verifica esplicita di questo invariante.

### URL consenso pazienti: base URL fisso

I link e-mail ai pazienti usano un base URL hardcoded (GitHub Pages),
non `window.location`. Questo è voluto: il deploy Docker gira su un host diverso
da quello su cui il paziente accede al modulo di consenso.
Cambiarlo romperebbe il flusso su Docker.

### Input utente: sempre `escapeHtml()` prima del DOM

Nessun input utente va inserito nel DOM senza sanitizzazione.
La funzione `escapeHtml()` è definita nel sorgente e va usata su tutti i campi liberi.

## Backup admin

Il canale di backup riservato usa ECDH P-256 + AES-GCM-256 (schema ECIES).
La chiave privata admin sta fuori dal repository in `TeleVisita_Admin/` — non va mai committata.

**Invariante sul merge**: il numero di pazienti nel backup non può mai scendere.
Il merge avviene sempre per unione su ID. I record esistenti non si cancellano mai.

## Test e pipeline CI/CD

I test E2E in `tests/e2e/` girano con Playwright headless Chromium
contro l'artefatto di produzione (`docs/`), non contro il sorgente.
Il workflow `.github/workflows/deploy.yml` blocca il deploy se anche un solo test fallisce.

`window._S` è un accessor read-only sullo stato interno dell'applicazione,
necessario per i test — non va rimosso.

La flag `S.demoMode` blocca l'invio di email reali durante la demo guidata.
