# agents.md — Standard di sviluppo Olovisita

Questo documento descrive le regole architetturali e operative che governano lo sviluppo
della piattaforma Olovisita. Chiunque lavori su questo codebase deve rispettarle senza
eccezioni: sono decisioni già prese e documentate qui perché non vengano riprese da zero
ad ogni sessione.

---

## 1. Struttura del progetto

| File | Ruolo |
|------|-------|
| `televisita_fix.html` | Sorgente di sviluppo — leggibile, commentato, versionato |
| `docs/index.html` | Artefatto di produzione — generato dallo script, mai modificato a mano |
| `build_minified.py` | Script deterministico che produce l'artefatto dal sorgente |
| `tests/e2e/` | Suite Playwright: 24 test comportamentali contro `docs/` |
| `.github/workflows/deploy.yml` | Pipeline CI/CD: test → deploy (bloccante) |
| `manuale/` | Documentazione PDF: privacy GDPR, governance metodologica |
| `TeleVisita_Admin/` | Strumenti admin fuori dal repo (chiave privata ECDH, receiver MQTT) |

`televisita.html` esiste come file separato ed è in `.gitignore` — ignorarlo completamente.

---

## 2. Workflow di build (tassativo)

Ogni modifica al sorgente segue questo workflow, senza eccezioni:

```
1. Modifico televisita_fix.html
2. python3 build_minified.py        # produce docs/index.html
3. git add televisita_fix.html docs/index.html
4. git commit && git push
```

Se il build script restituisce un errore (es. sintassi JS invalida), il commit non avviene.
Il deploy avviene automaticamente via GitHub Actions solo dopo che i 24 test E2E passano.

---

## 3. Lingua

- Commit e commenti nel codice: **italiano**
- Tono: diretto, tecnico, senza verbosità

---

## 4. Architettura: cosa fa il software

Olovisita è una SPA client-side (file singolo HTML+JS) che gestisce televisite mediche
tra due strutture (`struttura1` = Centro Tunisia, `struttura2` = Ospedale Cervello).
Non ha backend: tutto è in-memory con localStorage, MQTT per la sincronizzazione tra
strutture, ed EmailJS per le email ai pazienti.

### Stato applicazione

Lo stato globale vive nell'oggetto `S` (costante, non sostituire il riferimento):

```js
const S = {
  role: 'struttura1',      // struttura attiva
  televisite: [],          // array delle visite
  immReq: null,            // stato visita urgente ('pending'|'accepted'|null)
  immRoom: null,           // room Jitsi per visita urgente
  immReqSender: null,
  docs: [],                // documenti condivisi
  jitsiApi: null,          // istanza Jitsi corrente
  activeRoom: null,
  emails: [],              // log email inviate
  activeTvId: null,
  currentDoctor: null,
  patientNotes: {}
};
```

`window._S` è un accessor read-only su `S`, definito con `Object.defineProperty` con
`configurable: false`. Serve esclusivamente ai test E2E e al debug da console —
non va usato dal codice applicativo e non va mai rimosso.

### Funzioni esposte su `window` (usate dai test)

`window.switchRole(role)` — cambia struttura attiva senza passare dal login.
`window.requestImmediate(...)` — crea una richiesta di visita urgente.
`window.acceptImmediate()` — accetta la richiesta urgente dalla struttura2.
`window.submitCentroUrgentRequest(event)` — registra un accesso urgente Centro.

Queste funzioni non vanno rimosse: i test E2E dipendono da loro.

---

## 5. Decisioni di sicurezza architetturali

### 5.1 Il Codice Stanza non appare mai nell'UI

`currentGroupCode` è il segreto da cui derivano sia la chiave AES-GCM-256 (per
cifrare i messaggi MQTT) sia il topic MQTT (via SHA-256 + suffisso `"::topic"`).
Esporlo in chiaro — anche solo in un toast, un badge, un log di console — rompe
l'intero modello di sicurezza. Nell'UI compare solo il nome della stanza derivato,
mai il codice grezzo.

Il valore di default è `atob('T2xvdmlzaXRhX3BhbGVybW9fdHVuaXNpYQ==')` (riga 3884).
Non va loggato, non va inserito in nessun attributo visibile nel DOM.

**Eccezione documentata — flusso consenso paziente**: `currentGroupCode` compare nei
parametri `?room=` e `?code=` degli URL inviati via email al paziente
(`buildPatientConsentUrl` riga 7007, `buildPatientCallUrl` riga 7047). Questo è
architetturalmente necessario: il paziente accede al modulo di consenso senza login e
senza sessione, quindi deve ricevere il segreto fuori banda (via email) per poter
decriptare i dati della visita lato client. Non esiste alternativa senza un backend.
Questa è l'unica eccezione ammessa e non va estesa ad altri contesti.

### 5.2 Le televisite Centro non escono mai dal dispositivo

`getShared()` filtra `tv.visitMode !== 'centro'` **prima** della cifratura. Le visite
interne a una struttura non raggiungono mai il broker MQTT, nemmeno cifrate.

`visibleTelevisite()` filtra `tv.visitMode !== 'centro' || tv.scheduledBy === S.role`
prima di mostrare qualsiasi lista o contatore nell'UI.

Questo è un controllo architetturale doppio (sincronizzazione + UI): non va rimosso né
spostato. Ogni modifica a `syncState()`, `getShared()`, o a qualsiasi punto che itera
`S.televisite` richiede verifica esplicita di questo invariante.

### 5.3 URL consenso pazienti: base URL fisso

I link email ai pazienti usano un base URL hardcoded (GitHub Pages), non
`window.location`. Questo è voluto: il deploy Docker gira su un host interno diverso
da quello su cui il paziente accede al modulo di consenso. Cambiarlo romperebbe il
flusso su Docker.

### 5.4 Input utente: sempre `escapeHtml()` prima del DOM

Nessun input utente va inserito nel DOM con `innerHTML` senza sanitizzazione.
`escapeHtml(str)` è definita in sorgente (riga 4717) e va usata su tutti i campi
liberi. Non usare `.textContent` per aggirare il problema se poi il valore finisce
in un attributo HTML.

### 5.5 Password: hash SHA-256 lato client, mai testo in chiaro

Le password degli utenti sono confrontate come hash SHA-256 (hex). Gli hash sono
hardcoded in `FACILITIES` per ogni utente (riga 3677). Non si memorizzano mai
password in chiaro — né in localStorage, né in MQTT, né in log.

---

## 6. EmailJS

La configurazione EmailJS è per-struttura, con catena di fallback:

```js
DEFAULT_EMAILJS_CONFIGS = {
  struttura1: [sender_principale, sender_fallback],
  struttura2: [sender_principale, sender_fallback]
}
```

Il medico può sovrascrivere la configurazione dalle Impostazioni: il valore salvato in
`localStorage` (`tv_emailjs_config_<role>`) prende precedenza sull'intera catena di
default. Se l'override è presente ma malformato viene ignorato silenziosamente e si
usa il default.

Le email reali vengono inviate solo se `!S.demoMode`. Durante la demo guidata
`S.demoMode = true` blocca tutti gli invii reali.

I test E2E bloccano tutte le chiamate a domini emailjs con `page.route('**/*emailjs*/**', ...)`.

---

## 7. Jitsi

Il dominio Jitsi è configurato in un'unica costante (riga 2977):

```js
const JITSI_DOMAIN = 'jitsi.hamburg.ccc.de';
```

Questa è l'unica riga da cambiare per puntare a un'istanza self-hosted.
La E2EE Jitsi è deliberatamente disabilitata (`e2eeSupported: false, disableE2EE: true`)
perché funziona solo su Chromium e causerebbe fallimenti silenti su Firefox/Safari.
Documentato nel manuale della privacy (capitolo 3).

---

## 8. MQTT e cifratura della sincronizzazione

Il canale di sincronizzazione usa:
- **Topic**: derivato da SHA-256(`currentGroupCode` + `"::topic"`) — non prevedibile
  senza conoscere il codice stanza.
- **Cifratura payload**: AES-GCM-256, chiave derivata da SHA-256(`currentGroupCode`).
  Ogni messaggio ha IV random a 12 byte.
- **Broker**: `wss://broker.emqx.io:8084/mqtt` (pubblico, per demo).

Il topic base è `olohealth/televisita/demo/` + topic derivato.

In produzione o per un cambio di broker: modificare `MQTT_TOPIC_BASE` e il URL del
broker nella funzione di inizializzazione MQTT.

---

## 9. Backup admin (canale ECIES)

Il canale di backup riservato al gestore della piattaforma usa ECDH P-256 + AES-GCM-256
(schema ECIES con chiavi effimere per-messaggio).

- La **chiave pubblica admin** è embedded nel sorgente (riga ~4110, `ADMIN_BACKUP_PUBLIC_KEY_JWK`).
  Embeddarla è sicuro: permette a chiunque di cifrare, ma solo il titolare della chiave
  privata può decifrare.
- La **chiave privata** vive esclusivamente in `TeleVisita_Admin/` — mai nel repo.
- Il topic di backup è `olohealth/televisita/sys/8f2c4b6e1a/abk`.
- Per test/sviluppo: passare `?admin_test_topic=xxx` nell'URL per usare un topic
  separato e non sovrascrivere il backup reale.

**Invariante sul merge**: il numero di pazienti nel backup non può mai scendere.
Il merge avviene sempre per unione su ID: i record esistenti non si cancellano mai,
anche se non compaiono nel backup più recente. Questo vale sia nel receiver admin che
in qualsiasi script di analisi.

Il backup locale automatico (File System Access API, Chrome/Edge) salva il JSON completo
ogni 10 minuti nella directory scelta dall'utente. Il handle è persistito via IndexedDB
e ripreso ai reload. Implementato separatamente dal canale admin.

---

## 10. Test e pipeline CI/CD

I test E2E in `tests/e2e/` girano con Playwright headless Chromium contro l'artefatto
di produzione (`docs/`), servito da `python3 -m http.server 4321` prima del run.

**Il deploy è bloccato se anche un solo test fallisce.**

### Suite (24 test in 5 file)

| File | Test | Cosa verifica |
|------|------|---------------|
| `login.spec.js` | 5 | Login/logout, credenziali errate, accesso pannello admin |
| `schedule_visit.spec.js` | 4 | Prenotazione visita, data/ora, conflitti |
| `urgent_visit.spec.js` | 6 | Flusso urgente struttura1→2, accettazione, consenso automatico, Centro privato |
| `consent_flow.spec.js` | 5 | OTP, consenso firmato/negato/scaduto |
| `demo.spec.js` | 4 | Demo guidata, demoMode blocca email |

### Accesso allo stato nei test

```js
// Lettura dello stato interno
const val = await page.evaluate(() => window._S.immReq);

// Cambio struttura senza login
await page.evaluate(() => window.switchRole('struttura2'));
```

### Isolamento rete nei test

`loginBypass()` blocca sempre `emailjs` e `mqtt` prima di eseguire codice applicativo:

```js
await page.route('**/*emailjs*/**', route => route.abort());
await page.route('**/*.mqtt*/**', route => route.abort());
```

### Report CI

Il report HTML Playwright viene pubblicato come artefatto GitHub Actions a ogni run
(retention 30 giorni), anche in caso di successo. Il job summary mostra la tabella
delle suite con il conteggio dei test superati/falliti.
