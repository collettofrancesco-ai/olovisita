# agents.md — Standard di sviluppo Olovisita

Questo documento descrive l'architettura, le decisioni prese e le regole operative della
piattaforma Olovisita, dal primo commit (17/06/2026) ad oggi. Chiunque lavori su questo
codebase — umano o agente — deve rispettarle senza eccezioni: sono decisioni già prese e
motivate qui perché non vengano riprese da zero ad ogni sessione. Se una scelta sembra
strana, quasi certamente è la correzione di un incidente reale già successo — il "Why" di
ogni sezione spiega quale.

---

## 1. Struttura del progetto

| File/cartella | Ruolo |
|------|-------|
| `televisita_fix.html` | Sorgente di sviluppo — leggibile, commentato in italiano, versionato |
| `docs/index.html` | Artefatto di produzione — generato da `build_minified.py`, **mai modificato a mano** |
| `build_minified.py` | Minifica il JS di `televisita_fix.html` (via `terser`) in `docs/index.html` |
| `check_health.py` | Controlli pre-push: traduzioni IT/FR complete, sintassi JS valida, `FACILITIES`/`DEFAULT_EMAILJS_CONFIGS` coerenti, build sincronizzata e online |
| `manage_users.py` | Aggiunge/reimposta un utente medico partendo dal codice generato dal pannello admin, senza editing manuale |
| `manage_emailjs.py` | Gestisce le catene EmailJS per struttura (`DEFAULT_EMAILJS_CONFIGS`) |
| `manage_deployment.py` | Crea una nuova cartella di deployment per due strutture diverse (bianco/da configurare) |
| `Avvia_Server.command` | Apre la versione pubblica GitHub Pages con un doppio clic (uso non tecnico) |
| `Dockerfile` / `.dockerignore` | Immagine nginx minima che serve `docs/` — per il deploy interno Olomedia |
| `.github/workflows/deploy.yml` | CI/CD: test E2E → deploy GitHub Pages, **bloccante** se un test fallisce |
| `tests/e2e/` | Suite Playwright — 53 test in 7 file, vedi §14 |
| `tests/integration/` | Test MQTT reale isolato su topic casuali, dati sintetici e senza retain |
| `manuale/` | Documentazione PDF/HTML: privacy GDPR (`Valutazione_Sicurezza_GDPR_Olovisita`), manuali utente IT/FR |
| `TeleVisita_Admin/` | Strumenti dell'amministratore piattaforma, **fuori dal repo git** (contiene chiavi private) — vedi §13 |

`televisita.html` esiste come file separato ed è in `.gitignore` — ignorarlo completamente,
non è quello servito in produzione.

---

## 2. Workflow di build (tassativo)

```
1. Modifico televisita_fix.html
2. python3 build_minified.py        # produce docs/index.html
3. git add televisita_fix.html docs/index.html
4. git commit && git push
```

Se il build script fallisce (es. sintassi JS invalida rilevata da `terser`), il commit non
avviene. Il deploy su GitHub Pages parte in automatico via GitHub Actions solo dopo che
tutti i test E2E passano.

**Push automatico**: per questo repository, commit e push vanno fatti subito dopo ogni
modifica verificata (build + test verdi), senza fermarsi a chiedere conferma — scelta
esplicita dell'utente per eliminare l'attrito di conferme ripetute durante sessioni di
bugfix attive. Resta valida la prudenza ordinaria su operazioni distruttive (force-push,
reset --hard, riscrittura di history): quelle richiedono sempre conferma esplicita.

---

## 3. Lingua

- Commit e commenti nel codice: **italiano**, tono diretto e colloquiale (come se li
  scrivesse l'utente stesso), non un inglese tecnico-formale.
- Interfaccia medico: italiano/francese (selezionabile). Consenso paziente: vedi §8.

---

## 4. Architettura: cosa fa il software

Olovisita è una SPA client-side (file singolo HTML+JS) che gestisce televisite mediche
tra due strutture sanitarie (`struttura1` = Centro Tunisia, `struttura2` = Ospedale
Vincenzo Cervello - Ematologia MROE, Palermo). **Nessun backend**: stato in-memory +
localStorage, sincronizzazione tra strutture via MQTT (broker pubblico), email reali ai
pazienti via EmailJS, videochiamata via Jitsi (server proprio, vedi §10).

Questa è una scelta architetturale esplicita e riconfermata, non un limite provvisorio:
un backend con database risolverebbe strutturalmente alcuni residui di rischio (segretezza
del Codice Stanza, rate limiting lato server, audit trail centralizzato), ma richiederebbe
hosting sempre acceso — non disponibile con GitHub Pages — ed è stato scartato a favore di
mitigare i rischi residui uno alla volta sul client. **Non riproporre la migrazione a
backend/database di propria iniziativa.**

### Stato applicazione

Lo stato globale vive nell'oggetto `S` (costante, non sostituire il riferimento):

```js
const S = {
  role: 'struttura1',      // struttura mostrata — COSMETICO, vedi §5.9
  televisite: [],          // array delle visite
  immReq: null,            // stato visita urgente ('pending'|'accepted'|null)
  immRoom: null,           // room Jitsi per visita urgente
  immReqSender: null,
  docs: [],                // documenti condivisi
  jitsiApi: null,          // istanza Jitsi corrente
  activeRoom: null,
  emails: [],               // log email inviate
  activeTvId: null,
  auditLog: [],             // storico accessi — mai in getShared(), solo verso l'admin
  currentDoctor: null,
  patientNotes: {}
  // demoMode: assegnato dinamicamente da runDemo()/stopDemo(), non nel literal iniziale
};
```

`activeFacilityId` (variabile a parte, non su `S`) è la vera struttura autenticata,
impostata una sola volta da `selectFacility()` al login — **mai** dalla demo guidata. Vedi
§5.9 per la distinzione critica tra questa e `S.role`.

`window._S` è un accessor read-only su `S` (`Object.defineProperty`, `configurable:false`),
usato solo da test E2E/debug console — mai dal codice applicativo, mai da rimuovere.

### Funzioni esposte su `window` (usate dai test)

`window.switchRole(role)`, `window.requestImmediate(...)`, `window.acceptImmediate()`,
`window.submitCentroUrgentRequest(event)`, `window.resetAllData(skipConfirm)`. Non
rimuovere: i test E2E dipendono da loro. `switchRole` è accessibile da `window` **solo** in
ambienti di test (`_isTestEnv()`: localhost o porta non-80/443) — in produzione l'unico modo
di cambiare struttura attiva è un login vero.

---

## 5. Decisioni di sicurezza architetturali

### 5.1 Il Codice Stanza non appare mai nell'UI

`currentGroupCode` (default `atob('T2xvdmlzaXRhX3BhbGVybW9fdHVuaXNpYQ==')`, riga 3882) è
il segreto da cui derivano sia la chiave AES-GCM-256 per il canale Network sia il topic
MQTT (SHA-256 + suffisso `"::topic"`). Esporlo in chiaro — anche solo in un toast, un
badge, un log di console — rompe l'intero modello di sicurezza. Non va loggato, non va in
nessun attributo visibile nel DOM.

**Eccezione documentata — flusso consenso paziente**: `currentGroupCode` compare nei
parametri `?room=`/`?code=` degli URL inviati via email al paziente (`buildPatientConsentUrl`,
`buildPatientCallUrl`), architetturalmente necessario: il paziente non ha login, deve
ricevere il segreto fuori banda per decriptare i dati della visita lato client. Non esiste
alternativa senza backend. Unica eccezione ammessa, non estenderla ad altri contesti.

**Rotazione e mantenimento in vita**: l'admin ruota il codice dal pannello (`?admin=1`,
"Codice Stanza") e lo distribuisce via canale di controllo firmato ECDSA (§6). Quel
messaggio è `retain:true` su un broker pubblico gratuito che **non garantisce** di
conservarlo indefinitamente — se scade prima che una struttura si ricolleghi, quella
struttura resta silenziosamente sul codice vecchio e la sincronizzazione Network si ferma
(successo per davvero il 05-06/09/2026 con Struttura 1). Due mitigazioni in vigore:
1. `TeleVisita_Admin/refresh_control_channel.js`, schedulato ogni 12h via launchd sul Mac
   dell'admin, ripubblica il messaggio retained identico (nessuna chiave privata coinvolta,
   solo un "rinfresco" della ritenzione) — vedi §13.
2. Ogni struttura riporta nel proprio backup/riepilogo periodico `networkTopicId` (hash
   derivato dal codice attuale, non sensibile): il pannello admin confronta i valori REALI
   delle due strutture (`renderAdminGroupCodeStatus`) e mostra un avviso rosso esplicito se
   sono diversi, invece di fidarsi solo di "ho mandato lo stesso comando a entrambe" (quel
   confronto da solo non avrebbe rilevato l'incidente del 05-06/09, perché l'admin aveva
   davvero mandato lo stesso comando — il problema era che una struttura non l'aveva mai
   ricevuto).

**Da non fare mai**: rimettere un Codice Stanza ruotato come nuovo default hardcoded nel
sorgente pubblico "per evitare che scada" — vanificherebbe la rotazione, chiunque legga
GitHub potrebbe decifrare il traffico Network in tempo reale. Proposto e respinto
esplicitamente il 06/09/2026.

### 5.2 Le televisite Centro non escono mai dal dispositivo

`getShared()` filtra `tv.visitMode !== 'centro'` **prima** della cifratura — le visite
Centro non raggiungono mai il broker MQTT, nemmeno cifrate. `visibleTelevisite()` filtra
`tv.visitMode !== 'centro' || tv.scheduledBy === S.role` prima di mostrare qualsiasi
lista/contatore. Controllo architetturale doppio (sincronizzazione + UI), non spostare né
rimuovere.

**I documenti di una visita Centro SONO condivisibili su opt-in esplicito** (dal
23/06/2026): un medico può cliccare "Condividi" su un documento (consenso/referto/upload)
di una visita Centro e farlo arrivare all'altra struttura per un consulto — la VISITA
resta comunque sempre invisibile, solo il documento specifico può uscire, mai in
automatico. Consenso e referto firmato nascono `shared:false` per le Centro (diversamente
dalle Network, sempre auto-condivisi). Due punti devono restare coerenti se toccati:
il filtro docs di `getShared()` e quello di `renderDocs()` lato ricevente.

**Recidiva del leak, 3 episodi reali** (non solo teoria — vedi anche §5.9):
1. 23/06/2026 — `visibleTelevisite()` mancante/sbagliato: pazienti Centro visibili
   nell'altra struttura.
2. 25/06/2026 — `scheduleVisit()` mandava `syncState({kind:'visit_scheduled', patient,
   date, time})` incondizionatamente: anche se `getShared()` escludeva correttamente
   l'array delle visite, questo evento-notifica separato portava comunque nome/data/ora
   reali del paziente Centro nel toast/campanella dell'altra struttura.
3. 06/09/2026 — il pulsante "Condividi documento" **durante una videochiamata attiva**
   (`quickShareFromCall`) era mostrato per QUALSIASI visita, Centro incluso, e imposta
   sempre `shared:true` senza distinzione né conferma: usarlo su una Centro inviava
   davvero documento e nome paziente all'altra struttura. Fix: `launchJitsi` nasconde il
   pulsante se `visitMode==='centro'`, più guardia difensiva dentro `quickShareFromCall`
   stessa.

**Lezione**: `getShared()`/il filtro della lista principale è il confine "ovvio", ma
esistono più canali indipendenti che portano dati identificativi in parallelo (eventi
toast/campanella, bottoni "quick action" raggiungibili durante una chiamata attiva, future
funzionalità) — ognuno va controllato esplicitamente per Centro, il filtro sui dati non
protegge implicitamente questi canali laterali. `grep -n "S\.televisite"` per trovare punti
che leggono l'array direttamente invece di passare da `visibleTelevisite()`.

### 5.3 URL consenso pazienti: base URL fisso

I link email ai pazienti (`PUBLIC_PATIENT_BASE_URL`, riga 3823 —
`https://collettofrancesco-ai.github.io/olovisita/`) usano un dominio hardcoded, non
`window.location`. Voluto: il deploy Docker interno Olomedia gira su un host diverso da
quello su cui il paziente deve poter accedere da casa/mobile; essendo un'app 100%
client-side, qualunque deployment con lo stesso codice serve identicamente la pagina
pubblica — GitHub Pages è l'unico URL garantito sempre raggiungibile. I medici possono
usare indifferentemente GitHub Pages o il Docker interno giorno per giorno; solo i link
lato paziente sono fissati. Non "correggere" tornando a `window.location`.

### 5.4 Input utente: sempre `escapeHtml()`/`escapeAttr()` prima del DOM

`escapeHtml(str)` (riga 5493) per contenuto testuale, `escapeAttr(str)` (riga 5487, include
anche l'apice singolo) per valori interpolati dentro `onclick="...('VALORE')"`. Mai
`.textContent` per aggirare il problema se il valore finisce poi in un attributo. Incidenti
reali chiusi: XSS riflesso nel referto pubblico e "textarea breakout" nella Cartella
Clinica (23-24/06), 3 XSS in toast — `patientEmail`, errore EmailJS, `displayName` Jitsi
(07/07), SRI aggiunta sugli script CDN esterni (10/07).

**`sanitizeImportedVisit()`** (03/09/2026): un file di backup importato (`importDataBackup`)
non è dati fidati quanto quelli generati dall'app stessa — un `id`/`status`/`time`
malevolo in un backup "ricevuto da un collega" finiva altrimenti in `innerHTML` senza
controllo. Ogni televisita importata passa ora da questa validazione (id su charset
sicuro, status nella whitelist nota, time/date su formato atteso) prima di entrare in
`S.televisite`; per un backup generato da questa stessa app è un no-op trasparente.

### 5.5 Password: SHA-256 + stretching PBKDF2, mai testo in chiaro

`computeStoredPasswordHash(password, username)` — PBKDF2 100.000 iterazioni sopra
SHA-256, salt = username. **Mai** calcolare a mano `sha256Hex()` da solo per un
`passwordHash`. Hash hardcoded in `FACILITIES` per utente. Mai testo in chiaro in
localStorage, MQTT o log.

### 5.6 localStorage cifrato a riposo

`persistTvState()`/`loadSharedState()` cifrano `tv_state` con AES-GCM-256, chiave da
`currentGroupCode + '::localstorage'` (dominio separato da quella MQTT —
`getLocalStorageCryptoKey`, mai `getCryptoKey`/`cachedCryptoKey`). Riconosce ancora il
vecchio formato in chiaro per dispositivi non aggiornati e lo migra al primo salvataggio
successivo — non rimuovere senza un piano di migrazione esplicito.

### 5.7 Pannello admin: la chiave privata è il secondo fattore

`?admin=1` non ha un proprio login: chiunque conosca l'URL vede la richiesta chiave. La
sicurezza dipende interamente dalla segretezza delle chiavi private (mai nel repo,
incollate una tantum nel browser dell'admin) — è il comportamento voluto, equivalente a un
secondo fattore, non un pannello "senza protezione".

### 5.8 Canale verso l'admin: cifrato E autenticato (HMAC)

I dati che le strutture mandano all'admin (backup completo, riepilogo periodico,
richieste di reset password) usano `encryptForAdmin()` — schema ECIES verso
`ADMIN_BACKUP_PUBLIC_KEY_JWK` (riga 4197): dà **riservatezza** (solo l'admin decifra) ma
NON dava **autenticità**, perché quella chiave pubblica è per forza nel sorgente pubblico
— chiunque leggesse GitHub poteva forgiare un backup falso o una finta richiesta di reset
password per uno username reale.

Corretto il 06/09/2026 con un HMAC-SHA256 (`computeAdminChannelHmac`/
`verifyAdminChannelHmac`, righe 4431/4440) derivato da `currentGroupCode` — l'unico
segreto che sia le strutture SIA l'admin conoscono, incluso nel payload PRIMA della
cifratura, verificato subito dopo la decifratura in `handleAdminBackupMessage` e
`handleAdminPwRequestMessage`: un messaggio senza HMAC valido viene scartato prima di
toccare `adminReceivedBackups`/`mergeAdminAuditLog`. **Limite onesto**: non è forte quanto
ECDSA per-struttura (richiederebbe una nuova infrastruttura di chiavi) — chi
intercettasse anche il traffico MQTT del canale di controllo nel momento esatto di una
rotazione vedrebbe comunque il codice (quel canale è firmato ma non cifrato, §6). Alza la
soglia da "chiunque legga il sorgente" a "chi osserva anche il traffico MQTT dal vivo".

L'admin sincronizza il proprio `currentGroupCode` ad ogni rotazione applicata (anche da
un'altra sessione admin, tramite il canale di controllo già verificato via ECDSA) e lo
persiste (`tv_admin_known_groupcode`) per sopravvivere a un reload del pannello.

### 5.9 `activeFacilityId`, non `S.role`, in ogni canale/confronto sensibile

`S.role` è un flag **cosmetico**: la demo guidata (`runDemo`/`switchRole`) lo cambia per
narrare "l'altra struttura" restando sullo stesso dispositivo/sessione, senza un vero
secondo login. `activeFacilityId` è la vera identità autenticata, impostata una sola volta
da `selectFacility()`, mai toccata dalla demo. Qualunque canale che pubblica dati "di
questo dispositivo" (MQTT keyed per struttura, localStorage keyed per struttura) o che
FILTRA eventi in arrivo per decidere "è mio / è dell'altro" deve usare `activeFacilityId`.

**Incidente originale (10/08/2026, commit 09788db)**: diversi canali in background
(`publishAdminBackup`, `publishAdminSummary`, `publishSelfBackup`/`pushDocsSelfBackup`, il
campo `sender` del sync principale) leggevano `S.role` al momento della pubblicazione —
che può scattare (timer periodico, riconnessione broker) mentre la demo ha il ruolo
cosmetico temporaneamente cambiato, pubblicando dati REALI etichettati come dell'altra
struttura.

**Recidiva trovata il 03/09/2026** (audit a 10 agenti sul sorgente completo) nello STESSO
punto debole ma non ancora coperto dal fix originale: `handleIncomingSync` (il dispatcher
di OGNI evento MQTT/BroadcastChannel in arrivo — richieste urgenti, visite
programmate/accettate/rifiutate/annullate, documenti condivisi) e
`handleFacilityControlMessage` (scriveva `DOCTORS[S.role]` invece di
`DOCTORS[activeFacilityId]`). Entrambi corretti (commit `0b70a0d`).

**Lezione**: il fix del 10/08 aveva sistemato i canali di PUBBLICAZIONE noti in quel
momento, non c'era stata una ricerca sistematica di ogni uso di `S.role` in contesti
sensibili — includendo i dispatcher di RICEZIONE, non solo pubblicazione. `grep -n
"S\.role"` mirato prima di ogni modifica a un canale MQTT/sync è il modo per non ripetere
l'errore. Cache admin già contaminata da quell'incidente non viene ripulita
retroattivamente dal fix (l'unione per id, §5.11, non rimuove mai nulla da sola).

### 5.10 La demo guidata è isolata dal traffico reale

`S.demoMode` bloccava storicamente solo l'invio email reali. Corretto il 04-05/09/2026:
un medico che avviasse la demo restando connesso al broker reale avrebbe inviato all'altra
struttura vera notifiche/inviti/referti con pazienti fittizi mescolati ai dati reali. Il
controllo `if (S.demoMode) return;` è ora nei punti di pubblicazione più bassi e centrali
(`sendMQTTMessage`, `publishSelfBackup`, `pushDocsSelfBackup`, `publishCallStatus`, e sul
`bc.postMessage` di `syncState`), così copre ogni chiamante senza doverli modificare uno a
uno. I pazienti demo restano marcati `isDemo:true` e rimossi per davvero da
`removeDemoPatients()`/`stopDemo()` (unica vera cancellazione sincronizzata dell'app,
eccezione esplicita all'invariante union-only di §5.11) — pazienti demo creati PRIMA di
questo flag (senza `isDemo`) non si autopuliscono, vanno rimossi a mano.

### 5.11 Sincronizzazione: unione per id, mai sovrascrittura/cancellazione

`mergeById` in `handleIncomingSync` è **union-only**: un dispositivo che si connette con
cache vuota non deve mai far sparire dati già presenti sull'altro lato. Per una vera
televisita non esiste una funzione di eliminazione: annullare marca solo `status:
'annullata'` (`confirmCancelVisit`), mai una rimozione reale. Stesso principio per
`S.auditLog` (storico accessi: due dispositivi della stessa struttura devono confluire in
un unico totale, non isolarsi — riscontrato in produzione il 12/08/2026 con due pannelli
admin che vedevano numeri diversi) e per il backup admin (§12: il conteggio pazienti non
può mai scendere). Unica eccezione: la rimozione esplicita dei pazienti demo (§5.10).

### 5.12 Sessione persistente sul dispositivo (`tv_session`)

Fino al 05/09/2026, `S.currentDoctor` viveva solo in memoria: ricaricare la pagina
riportava sempre al login, anche a metà di una televisita reale. `submitLogin` ora salva
`{role, username}` (**mai** la password) in `localStorage['tv_session']`;
`tryRestoreSession()`, chiamato al boot dopo `loadSharedState()`, lo rilegge e salta il
form se corrisponde a un utente reale della struttura — stesso esito di un login riuscito,
senza ridigitare le credenziali su un dispositivo che le ha già dimostrate una volta.
`logout()` lo ripulisce. Un account disattivato dall'admin viene comunque intercettato dal
canale di controllo (§6) appena l'MQTT si connette, quindi non introduce un buco per
account già disattivati.

**Guardia anti-doppio-submit**: `submitLogin()` attende fino a 1.5s
(`waitForLoginControlOverride`) prima di leggere la password, senza alcun riscontro
visibile a schermo. Un secondo Invio/click in quella finestra avviava una chiamata
concorrente che leggeva il campo password ormai svuotato dalla prima (sia successo che
fallimento lo azzerano), registrando un `login_fail` fantasma subito dopo un
`login_success` reale (osservato in produzione 05-07/09/2026). `submitLogin` è ora un thin
wrapper con una guardia in-flight (`loginInFlight`) attorno alla vera logica
(`submitLoginInner`) — un secondo tentativo mentre il primo è in corso viene ignorato.

---

## 6. Canale di controllo admin → struttura (ECDSA)

Il pannello admin ha, oltre al canale di lettura backup (§12), un canale di **scrittura**
in direzione OPPOSTA (admin → struttura), per gestione utenti reale e configurazione
remota senza toccare il sorgente:

- **Topic**: `ADMIN_BACKUP_TOPIC + '/control/' + role` (uno per struttura), `retain:true`.
- **Payload in chiaro ma firmato ECDSA P-256** (non serve confidenzialità: i
  `passwordHash` sono comunque già visibili nel sorgente pubblico) — una SECONDA coppia di
  chiavi, separata da quella ECDH dei backup. Si firma/verifica la stringa JSON esatta
  come trasmessa (`envelope.data`), mai una ricostruzione lato ricevente.
- **Chiavi**: generate da `TeleVisita_Admin/generate_control_key.js`. Pubblica →
  `ADMIN_CONTROL_PUBLIC_KEY_JWK` hardcoded (riga 4208). Privata →
  `TeleVisita_Admin/admin_control_private_key.DO_NOT_SHARE.json`, incollata nel pannello
  admin in un campo separato e opzionale ("Chiave di controllo").
- **Cosa può fare**: attivare/disattivare un account, resettare una password (con
  "Applica subito" dalle richieste inviate dal medico), aggiornare nome/specializzazione,
  config EmailJS/intervallo di backup per struttura, ruotare il Codice Stanza (§5.1).
- **Fail-open al login** (scelta esplicita): `submitLogin` attende max 1.5s un eventuale
  override prima di validare le credenziali; se il canale non risponde, si procede con le
  sole credenziali hardcoded — un account disattivato potrebbe quindi accedere durante un
  disservizio del canale, accettato deliberatamente per non bloccare mai un medico per un
  problema di rete che non dipende da lui.
- **Dove si applica**: pre-login (`startLoginControlListener`, client MQTT temporaneo di
  sola lettura) e post-login (il `mqttClient` principale si iscrive anche al proprio topic
  di controllo — un override che disattiva l'utente corrente forza il `logout()`).

**Confermato funzionante end-to-end in un browser reale il 03/09/2026** (popup di
richiesta svuotamento dati arrivato davvero su un dispositivo connesso).

---

## 7. Sessione persistente e consensi multilingua

Vedi §5.12 per la sessione persistente. Per i consensi multilingua:

**Consenso paziente in italiano o francese+arabo, mai una lingua fissa**: `getConsentLangs()`
sceglie le lingue del documento in base a `currentLang` (interfaccia del medico che invia
il consenso) — `['it']` se italiano, `['fr','ar']` se francese (mai l'arabo da solo, mai
insieme all'italiano). Richiesto dalla Dott.ssa Mahjoub (Tunisi) il 04/09/2026,
implementato lo stesso giorno. Funzioni di supporto: `tIn(lang, key, data)` (traduzione in
una lingua esplicita, indipendente da `currentLang`), `consentBodyHtml()`,
`consentBlocks()`, `consentInline()` — usate sia per il documento che il paziente firma sia
per le email di invito/OTP. L'arabo usa `dir="rtl"`. **Bug corretto lo stesso giorno**: la
schermata OTP (istruzioni, bottone firma, errore, messaggio successo) inizialmente usava
ancora `t()` (legata a `currentLang`, quindi mai l'arabo) invece di `consentInline()`,
nonostante la traduzione araba esistesse già nel dizionario — se si tocca di nuovo questo
flusso, verificare che ogni testo mostrato al paziente passi da `consentInline()`/
`consentBlocks()`, mai da `t()` diretto.

---

## 8. EmailJS

`DEFAULT_EMAILJS_CONFIGS` è un oggetto per struttura (non un array flat), ciascuna con
catena [principale, fallback]:

- **struttura1 — Centro Tunisia** (`centredetunisie@gmail.com`): principale
  `service_7vcs3fy`/`template_99fap0n`, fallback l'account di fabbrica condiviso.
- **struttura2 — Ospedale Vincenzo Cervello** (`ospedalecervello.televisita@gmail.com`):
  principale `service_eiojz1j`/`template_k3vjztm`, stesso fallback di fabbrica.

`getEmailJsConfigs()` sceglie la catena in base al ruolo. Override per-browser in
localStorage (`tv_emailjs_config_<role>`), se malformato ignorato silenziosamente e si
torna al default. Le email reali partono solo se `!S.demoMode`. Template EmailJS
condiviso ("Contact Us" modificato) con variabili `{{to_email}}`, `{{to_name}}`,
`{{subject}}`, `{{message}}`, `{{invite_url}}`, `{{action_label}}`, `{{otp_code}}`.

**Problema noto**: le email finiscono talvolta nello spam (Gmail + watermark gratuito
EmailJS). Soluzione a lungo termine valutata ma non implementata: SendGrid con dominio
verificato. Per ruotare/aggiungere account: `python3 manage_emailjs.py`.

---

## 9. Jitsi (videochiamata)

```js
const JITSI_DOMAIN = 'oloconferencenew.olomedia.com';  // riga 2891, script tag riga 2883
```

**Server proprio Olomedia**, dal 07/09/2026 — nessun limite di tempo, nessun blocco di
framing, lingua IT/FR piena, affidabilità sotto controllo diretto (non un servizio
pubblico di terzi). Se dà problemi in futuro, il referente è il programmatore Olomedia,
non un servizio da sostituire.

**Storico (03-06/09/2026, per non riproporre le stesse idee)**: in una manciata di giorni
sono state provate e scartate tutte le alternative gratuite pubbliche ragionevoli —
`meet.jit.si` (8x8): affidabile ma l'integrazione **incorporata** (quella usata qui, video
+ cartella clinica affiancati via `JitsiMeetExternalAPI`) è limitata a 5 minuti per
spingere verso il loro prodotto a pagamento; `meet.ffmuc.net`: blocco
`Content-Security-Policy: frame-ancestors` che impedisce strutturalmente l'iframe da un
dominio esterno, non un problema di uptime; `jitsi.hamburg.ccc.de`: nessun limite ma
inaffidabile (irraggiungibile, errori di connessione durante chiamate reali) e forzava
l'interfaccia in tedesco nonostante `lang`/`defaultLanguage` passati correttamente (causa
mai isolata con certezza, verosimilmente una configurazione server-side che ignora
l'override client). Non riproporre nessuna delle tre.

**`disableDeepLinking`**: sui link diretti aperti dal paziente su mobile (non
l'integrazione incorporata, che già lo passa in `configOverwrite`), l'hash URL deve
includere `&config.disableDeepLinking=true` — altrimenti Jitsi mostra una pagina
promozionale in inglese ("scarica l'app") invece di entrare subito in chiamata nel
browser. Tre punti nel codice costruiscono questo URL (`initPatientCallView`, due
fallback in `launchJitsi`/`endCall`), tutti allineati dal 07/09/2026.

`p2p:{enabled:false}` deliberato (evita un fallimento di session-accept alla
transizione P2P→SFU). E2EE Jitsi disabilitata deliberatamente (solo Chromium la supporta,
fallirebbe silenziosamente su Firefox/Safari).

---

## 10. MQTT e cifratura della sincronizzazione

- **Topic**: SHA-256(`currentGroupCode + "::topic"`) — non prevedibile senza il codice.
- **Cifratura payload**: AES-GCM-256, chiave da SHA-256(`currentGroupCode`), IV random 12
  byte per messaggio.
- **Broker**: `wss://broker.emqx.io:8084/mqtt` — **UN SOLO broker**, deliberatamente senza
  fallback automatico ad altri (righe vicino a `MQTT_BROKERS`, riga 6316). Un vecchio
  fallback EMQX→HiveMQ→Mosquitto aveva smistato una struttura su un broker diverso
  dall'altra (11/08/2026, "connack timeout" lato rete di quella sede) — entrambe restavano
  "connesse" al proprio broker senza mai vedersi. Se EMQX diventasse inaffidabile in modo
  permanente, sostituire questa voce con un broker diverso, **mai** aggiungerne un
  secondo con fallback.
- Topic base: `olohealth/televisita/demo/` + topic derivato.

---

## 11. Backup admin (canale ECIES) — lettura

- **Chiave pubblica** admin (`ADMIN_BACKUP_PUBLIC_KEY_JWK`, riga 4197) hardcoded — sicuro
  da esporre, permette a chiunque di cifrare ma solo il titolare della privata decifra.
- **Chiave privata**: solo `TeleVisita_Admin/admin_private_key.DO_NOT_SHARE.json`, mai nel
  repo.
- Topic: `olohealth/televisita/sys/8f2c4b6e1a/abk` (fisso, non derivato dal Codice
  Stanza). Test: `?admin_test_topic=xxx` per isolare dal canale reale — **obbligatorio**
  per qualunque test su questa funzione (il primo giro senza questo parametro pubblicò
  davvero backup finti sul topic di produzione).
- **Invariante union-only** (§5.11): il conteggio pazienti non può mai scendere tra un
  backup e il successivo — merge sempre per unione su id, sia in `admin_listener.js` sia
  nella vista admin in-browser (`adminReceivedBackups`).
- **Autenticazione HMAC**: vedi §5.8 — backup/riepilogo/richieste password sono ora anche
  autenticati, non solo cifrati.
- Vista admin in-app (`?admin=1`): sola lettura, nessuna azione (quella vera è il canale
  di controllo, §6). Non tocca mai lo stato `S` globale (registro separato
  `adminReceivedBackups`).
- Backup locale automatico (diverso, per-medico): File System Access API, Chrome/Edge
  solo, scrive ogni 10 minuti nella cartella scelta, handle persistito via IndexedDB.

---

## 12. Strumenti esterni (`TeleVisita_Admin/`, fuori dal repo git)

| File | Ruolo |
|------|-------|
| `admin_private_key.DO_NOT_SHARE.json` / `admin_public_key.json` | Coppia ECDH per il backup (§11) |
| `admin_control_private_key.DO_NOT_SHARE.json` / `admin_control_public_key.json` | Coppia ECDSA per il canale di controllo (§6) |
| `generate_control_key.js` | Genera la coppia ECDSA — eseguito una sola volta |
| `admin_listener.js` | Ascolta i backup cifrati, li decifra, scrive `struttura{1,2}_ultimo_backup.json` |
| `refresh_control_channel.js` | Ripubblica il messaggio di controllo retained per rinnovarne la ritenzione sul broker (§5.1) — non serve la chiave privata |
| `com.televisita.refreshcontrol.plist` (in `~/Library/LaunchAgents/`) | Job launchd che esegue `refresh_control_channel.js` ogni 12h + al login; log in `refresh_control_channel.log` |

`launchctl bootout gui/$(id -u)/com.televisita.refreshcontrol` per disattivare il job se
mai necessario.

---

## 13. Test e pipeline CI/CD

Playwright headless Chromium contro l'artefatto di produzione (`docs/`), servito da
`python3 -m http.server 4321` prima del run. **Il deploy è bloccato se anche un solo test
fallisce.**

### Suite E2E (53 test in 7 file)

| File | Test | Cosa verifica |
|------|------|---------------|
| `login.spec.js` | 5 | Login/logout, credenziali errate, accesso pannello admin |
| `schedule_visit.spec.js` | 4 | Prenotazione visita, data/ora, conflitti |
| `urgent_visit.spec.js` | 6 | Flusso urgente struttura1→2, accettazione, consenso automatico, Centro privato |
| `consent_flow.spec.js` | 5 | OTP, consenso firmato/negato/scaduto |
| `demo.spec.js` | 6 | Demo guidata, demoMode blocca email, `resetAllData` non tocca l'audit log |
| `security.spec.js` | 8 | Rate limiting login, cifratura a riposo, hash rafforzato, merge audit log, segreto F-01 dedicato ai link paziente |
| `regressions.spec.js` | 19 | Confini privacy Centro, import non fidati, HMAC admin, lingue consenso, link paziente, UI documenti, contesto paziente e diagnostica |

### Suite MQTT reale (2 test separati)

`npm run test:mqtt` collega due browser al broker EMQX tramite un topic casuale per ogni
esecuzione. Usa soltanto pazienti sintetici e `retain:false`; verifica il viaggio completo
Struttura 1 → Struttura 2 → Struttura 1, l'esclusione delle visite Centro, l'unione di
stati concorrenti e lo scarto di payload cifrati con una chiave errata. È separata dalla
pipeline bloccante perché un disservizio esterno del broker non deve impedire il deploy.

### Accesso allo stato nei test

```js
const val = await page.evaluate(() => window._S.immReq);
await page.evaluate(() => window.switchRole('struttura2'));
```

### Isolamento rete nei test

`loginBypass()` blocca sempre `emailjs`/`mqtt` prima di eseguire codice applicativo:

```js
await page.route('**/*emailjs*/**', route => route.abort());
await page.route('**/*.mqtt*/**', route => route.abort());
```

Nota su `submitLogin` asincrona (§5.12): un test che simula più tentativi di login deve
sempre attendere il riscontro (`errEl` valorizzato) prima del click successivo — click
troppo ravvicinati vanno in race sulla stessa guardia `loginInFlight` pensata per gli
utenti reali.

Report HTML Playwright pubblicato come artefatto GitHub Actions ad ogni run (retention 30
giorni). Il pannello admin (`?admin=1`) **non ha copertura E2E** — verificare a mano o con
script Node isolati (vedi §5.8, verifica HMAC fatta così) le modifiche in quell'area.

---

## 14. Cronologia dei passaggi architetturali principali

Solo le decisioni/incidenti che cambiano come va letto il codice oggi — non un changelog
di ogni bug (quello sta nei commit git). Ordine cronologico:

| Data | Cosa |
|------|------|
| 17/06/2026 | Primo commit — consenso paziente con OTP, GitHub Pages via `docs/` |
| 22/06/2026 | Codice Stanza mascherato in UI; config EmailJS di default incorporata (deploy Docker) |
| 22-23/06/2026 | Lavagna collaborativa: sincronizzazione host-authoritative (§ commenti nel codice) |
| 22/06/2026 | Introdotta la modalità "Televisita Centro" (privata a una struttura) |
| 23/06/2026 | Backup admin (ECIES) + vista admin in-app `?admin=1` (sola lettura) |
| 23/06/2026 | Documenti Centro condivisibili su opt-in (§5.2) |
| 23/06/2026 | Backup automatico locale (File System Access API) |
| 10/07/2026 | Giro di sicurezza OWASP: SRI su CDN, `escapeAttr()`, rate limiting login |
| 10/08/2026 | Canale di controllo admin→struttura (ECDSA), §6 |
| 10/08/2026 | Leak pre-login critico corretto: dati pazienti + bottone "Avvia" funzionante sopra la schermata di login (`isDoctorAuthenticated`) |
| 10/08/2026 | Leak `S.role` vs `activeFacilityId`, primo episodio (§5.9) |
| 12/08/2026 | Suite di test E2E dedicata alla sicurezza |
| 03/09/2026 | Audit a 10 agenti paralleli su tutto il sorgente: 47 findings, i 6 critici corretti lo stesso giorno (canale admin non autenticato, XSS import backup, `room` non sanificato, entropia stanza Jitsi, recidiva `S.role`/`activeFacilityId` in `handleIncomingSync`, demo non isolata da MQTT) |
| 04/09/2026 | Presentazione del software ai referenti ospedalieri di Tunisi; richiesta e implementazione consenso bilingue FR+AR (§7) |
| 05/09/2026 | Sessione persistente (`tv_session`, §5.12); incidente disallineamento Codice Stanza reale, rilevamento automatico aggiunto (§5.1) |
| 06/09/2026 | Autenticazione HMAC del canale verso l'admin (§5.8); leak Centro via "Condividi documento" in chiamata (§5.2, terzo episodio) |
| 07/09/2026 | Jitsi passato al server proprio Olomedia, chiudendo la ricerca di alternative pubbliche (§9) |
