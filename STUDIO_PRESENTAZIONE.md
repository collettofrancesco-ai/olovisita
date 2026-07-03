# TeleVisita (oloHealth) — Guida di studio per la presentazione

> File di preparazione personale, non fa parte dell'app. Obiettivo: conoscere il codice a fondo per rispondere con sicurezza a domande tecniche di altri sviluppatori. Tutti i riferimenti a righe sono relativi a `televisita_fix.html` (il file di sviluppo "vero" — vedi sezione 0).

---

## 0. Cosa è il progetto, in due frasi

**oloHealth Televisita** è una piattaforma web di televisita medica tra due strutture sanitarie (Centro Tunisia e Ospedale Vincenzo Cervello — Ematologia, Palermo), che gestisce programmazione visite, consenso informato del paziente con firma OTP, videochiamata integrata (Jitsi), condivisione documenti clinici e una lavagna collaborativa in tempo reale per annotare immagini diagnostiche durante la visita.

È una **single-page application interamente client-side**: niente framework (no React/Vue/Angular), niente build tool, niente backend proprio, niente database. Tutto lo stato vive nel browser (`localStorage`) e la sincronizzazione tra le due strutture avviene tramite un **broker MQTT pubblico** con i messaggi **cifrati end-to-end** prima di partire.

### File del progetto
- `televisita_fix.html` — **il file di sviluppo reale**, leggibile, ~8550 righe (HTML+CSS+JS in un solo file). È quello su cui si lavora.
- `televisita.html` — versione vecchia/locale, **ignorata da git** (`.gitignore`), non è la fonte di verità.
- `docs/index.html` — versione **pubblicata** (GitHub Pages legge la cartella `docs/`), generata da `build_minified.py` che minifica il JS con `terser` e copia `vendor/` (pdf.js locale).
- `vendor/pdf.min.js`, `vendor/pdf.worker.min.js` — **pdf.js ospitato in locale** invece che da CDN: se un firewall ospedaliero blocca i CDN esterni, il rendering PDF nella lavagna collaborativa non deve fallire in silenzio (altrimenti l'altezza del canvas calcolata sui due lati diverge e le annotazioni finiscono nel punto sbagliato).
- `manuale/manuale_it.html`, `manuale_fr.html` + relativi PDF — manuale utente per il personale medico (in italiano e francese), 13 capitoli con screenshot.
- `Avvia_Server.command` — script per lanciare un server locale (gitignored).

**Perché un solo file HTML e non un progetto con build step?** Perché l'app deve poter girare anche solo apparendo come pagina statica (GitHub Pages) o aperta da `file://`/server locale in un ospedale, senza npm install, senza Node in produzione. L'unico uso di Node/npm è lo script di minificazione lanciato a mano dallo sviluppatore (`build_minified.py` chiama `npx terser`), mai in produzione.

---

## 1. Stack tecnologico (tutto via CDN, tranne pdf.js)

| Libreria | Uso | Dove |
|---|---|---|
| Bootstrap 5.3.2 + Bootstrap Icons | UI/CSS, modali, dropdown | CDN jsdelivr |
| **MQTT.js 4.3.7** | Sincronizzazione realtime tra le due strutture | CDN cdnjs |
| **EmailJS Browser SDK v3** | Invio email reali (opzionale) | CDN jsdelivr |
| **pdf.js** | Rendering PDF nella lavagna collaborativa | **Locale**, `vendor/` |
| **Jitsi Meet External API** | Videochiamata integrata | `https://jitsi.hamburg.ccc.de/external_api.js` (istanza pubblica) |
| Google Fonts (Outfit) | Tipografia | CDN |
| Web Crypto API (`crypto.subtle`) | Cifratura E2EE AES-GCM | Nativa del browser, nessuna libreria |

Nessun framework JS, nessun bundler, nessuna libreria di state management: un singolo oggetto globale `S` (vedi sezione 2) e funzioni che ri-renderizzano il DOM a mano con `innerHTML`.

---

## 2. Stato applicativo e persistenza

### Oggetto `S` (riga ~2793)
```js
const S = {
    role: 'struttura1',       // o 'struttura2': la struttura con cui sono loggato
    televisite: [],           // tutte le visite (programmate + urgenti)
    immReq: null,             // stato richiesta urgente: null|'waiting'|'accepted'|'rejected'
    immRoom: null,            // nome stanza Jitsi per la richiesta urgente in corso
    immReqSender: null,       // chi ha fatto la richiesta urgente ('struttura1'|'struttura2')
    docs: [],                 // documenti clinici (bozze locali + condivisi)
    jitsiApi: null,           // istanza JitsiMeetExternalAPI quando una call è attiva
    activeRoom: null,         // stanza Jitsi attualmente attiva
    emails: [],               // casella email simulata del paziente
    activeTvId: null,         // id della visita/paziente attualmente "a fuoco" (cartella clinica)
    currentDoctor: null       // profilo del medico loggato in questo momento
};
```

### Strutture e utenti (riga ~2756)
`FACILITIES` contiene le due strutture (`struttura1` = Centro Tunisia, `struttura2` = Ospedale Vincenzo Cervello), ciascuna con 2 medici (`username`, `name`, `spec`, `passwordHash`). `DOCTORS` è una versione "leggera" usata ovunque nella UI per mostrare nome/specializzazione del medico attivo per struttura, ed è popolata da `submitLogin()` con i dati dell'utente che ha fatto login.

### Persistenza
- **`localStorage` chiave `tv_state`**: tutto lo stato condivisibile (visite, documenti **inclusi i base64Data dei file**, email, stato richieste urgenti). Scritto da `syncState()` (riga ~3221) a ogni cambiamento, letto da `loadSharedState()` (riga ~3254) al caricamento pagina.
- **`localStorage` chiave `tv_emailjs_config`**: credenziali EmailJS se il medico le configura (vedi sezione 9).
- Due funzioni distinte costruiscono "fette" diverse dello stato:
  - `getSharedStateForStorage()` (riga 2816) → tutto, **incluso `base64Data`**, per `localStorage`.
  - `getShared()` (riga 2828) → **senza `base64Data`** (i file binari non passano per MQTT, sono troppo pesanti) e senza documenti privati dell'altra struttura, usata per i payload MQTT.
- **`BroadcastChannel('televisita_sync')`** (riga 2814): sincronizza istantaneamente più tab dello stesso browser sullo stesso PC, indipendentemente da MQTT.

Non esiste **nessun server applicativo**: niente è scritto su un DB centrale. Se un medico svuota la cache del browser, la sua copia dello stato locale sparisce (ma l'altra struttura, se ha ancora il suo `localStorage`, mantiene la sua versione — non c'è una "verità" centrale).

---

## 3. Login e autenticazione

Flusso (`selectFacility()` → `submitLogin()`, righe 3526-3685):
1. Si seleziona la struttura (card "Centro Tunisia" / "Ospedale Vincenzo Cervello").
2. Si scelgono profilo medico (dropdown popolato da `FACILITIES[id].users`) e password.
3. `submitLogin()` calcola `sha256Hex(password)` (usa `crypto.subtle.digest` se disponibile, altrimenti `sha256Fallback()` — un'implementazione SHA-256 scritta a mano in puro JS, riga 3581, usata solo in contesti non sicuri come `http://IP-locale` dove `crypto.subtle` non è disponibile) e lo confronta con `user.passwordHash` hardcoded nell'oggetto `FACILITIES`.
4. Se il match è corretto, salva `S.currentDoctor`, chiude l'overlay di login, chiama `switchRole(activeFacilityId)` e **avvia la connessione MQTT** con `initMQTT(roomCode)`, dove `roomCode` viene dal campo "Codice Stanza" del form di login (default: `cervello-tunisia`).

**Punti da sapere se chiesti:**
- Le password non vengono mai mandate in rete: tutto il check è client-side. Gli hash sono nel codice sorgente (quindi leggibili/attaccabili da chi ha accesso al file, ma non c'è API che li esponga a un attacco da remoto).
- Non c'è gestione sessione/token: il login resetta solo variabili in memoria + mostra il cruscotto. Il refresh della pagina richiede nuovo login (lo stato dati però persiste in `localStorage` indipendentemente dal login).
- Il **"Codice Stanza"** è la cosa più importante concettualmente: è sia il nome del topic MQTT sia il seed della chiave di cifratura (sezione 4). Deve essere lo stesso su entrambi i PC che vuoi sincronizzare.

---

## 4. Sincronizzazione realtime: MQTT + crittografia E2EE

Questa è la parte architetturalmente più interessante e quella su cui è più probabile ricevere domande mirate.

### 4.1 Perché MQTT e non WebSocket/Firebase/backend proprio
Non c'è un server applicativo. MQTT su un **broker pubblico** dà un canale pub/sub gratuito, già pronto, raggiungibile da entrambe le strutture senza dover gestire infrastruttura. Il prezzo da pagare è che il broker è pubblico (chiunque potrebbe sottoscrivere lo stesso topic) — da cui la necessità della cifratura E2EE lato applicazione, **non delegata al broker**.

### 4.2 Broker e topic (righe 2849-2850, 3072-3076)
```js
const MQTT_TOPIC_BASE = 'olohealth/televisita/demo/';
let currentGroupCode = 'cervello-tunisia';   // viene sovrascritto dal "Codice Stanza" del login
const MQTT_BROKERS = [
  { url: 'wss://broker.emqx.io:8084/mqtt',     name: 'EMQX Secure' },
  { url: 'wss://broker.hivemq.com:8884/mqtt',  name: 'HiveMQ Secure' },
  { url: 'wss://test.mosquitto.org:8081/mqtt', name: 'Mosquitto Secure' }
];
```
`initMQTT(groupCode, brokerIndex)` (riga 3102) tenta il broker `brokerIndex`; se entro 5 secondi non si connette, `tryNextBroker()` passa al broker successivo della lista. Sottoscrive il topic `MQTT_TOPIC_BASE + groupCode` con **QoS 1** ("at least once": il broker conferma la ricezione con un PUBACK e ritrasmette se non arriva conferma — scelto apposta per evitare perdite silenziose di tratti di disegno o di pacchetti di stato, a differenza di QoS 0 "fire and forget").

C'è anche un topic **per-stanza Jitsi**: `MQTT_TOPIC_BASE + room + '/status'`, usato da `publishCallStatus()` (riga 3065) con flag **`retain: true`**. Significato pratico: se il paziente apre il link della videochiamata *dopo* che i medici hanno già chiuso la call, il broker gli restituisce subito l'ultimo valore pubblicato ("ended") anche se nessuno è online in quel momento — è quello che mostra "La videochiamata è terminata" nella vista pubblica paziente (`initPatientCallView()`, riga 4452). Questo canale **non è cifrato** (contiene solo la stringa "active"/"ended", nessun dato del paziente).

### 4.3 Cifratura end-to-end (righe 2854-2992) — **questo è il punto più probabile da approfondire**
```js
async function getCryptoKey(roomCode) {
    if (!isSubtleCryptoSupported) return null;
    if (cachedCryptoKey) return cachedCryptoKey;          // cache: non si ricalcola a ogni messaggio
    const rawKey = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(roomCode));
    cachedCryptoKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt','decrypt']);
    return cachedCryptoKey;
}
```
- La chiave AES-GCM-256 è derivata con **SHA-256 del `roomCode`** (es. "cervello-tunisia"). Stesso codice stanza su entrambi i PC → stessa chiave, calcolata indipendentemente sui due lati (niente scambio di chiavi in rete, niente terza parte coinvolta).
- `encryptPayload(payloadObj, roomCode)` (riga 2926): serializza l'oggetto in JSON, genera un **IV casuale a 12 byte** per ogni messaggio (`crypto.getRandomValues`), cifra con `crypto.subtle.encrypt({name:'AES-GCM', iv}, key, plaintext)`. Ritorna `{iv, ciphertext}` in Base64.
- `decryptPayload()` (riga 2963) fa l'inverso con `crypto.subtle.decrypt`.
- **Fallback XOR** (`xorEncryptDecryptBytes`, riga 2895): se `crypto.subtle` non è disponibile (contesto non sicuro, es. `http://` non-localhost), cifra XOR-ando ogni byte con un keystream derivato da un hash tipo djb2 (`5381`, shift/add) del `roomCode`. In questo caso `iv` viene marcato come stringa letterale `"FALLBACK"` così il destinatario sa di dover usare XOR e non AES-GCM per decifrare.
- L'invio effettivo (`sendMQTTMessage()`, riga 3040) cifra sempre il payload con `encryptPayload()` prima di pubblicarlo, dentro una "busta" `{ sender: S.role, iv, ciphertext }`.

**Onestà tecnica da avere pronta se un developer scettico insiste:**
- È crittografia *vera* (AES-GCM-256 con IV casuale, nessun riuso di IV → ciphertext diverso ogni volta anche per testo identico), non semplice offuscamento — quando il browser supporta Web Crypto.
- **Ma** la chiave è interamente derivabile dal `roomCode`, che non è un segreto forte: è visibile nel form di login, finisce nell'URL dei link inviati al paziente (sezione 6), e non c'è alcun key-exchange protetto da password robusta o da un canale separato. Quindi protegge bene da un *osservatore passivo del traffico sul broker pubblico* (l'obiettivo principale: impedire che chi sottoscrive lo stesso topic per curiosità legga i dati clinici), ma **non è un sistema di sicurezza enterprise-grade con gestione chiavi**. È corretto descriverlo come "E2EE applicativa con chiave derivata da un codice condiviso", non come "crittografia a prova di attacco mirato".
- AES-GCM è AEAD (autenticato): un payload manomesso fallisce la decrypt invece di restituire dati corrotti silenziosamente — quindi c'è comunque integrità del messaggio, anche senza scambio di chiavi asimmetrico.

### 4.4 Sincronizzazione dello stato (`syncState`, riga 3221)
Ogni azione che modifica lo stato (nuova visita, accettazione, firma consenso, ecc.) chiama `syncState(event)`, che:
1. Scrive tutto lo stato (incluso `base64Data`) in `localStorage` (riga ~3231);
2. Notifica le altre tab dello stesso browser via `BroadcastChannel` (riga ~3237);
3. Manda su MQTT una versione "leggera" (`getShared()`, senza `base64Data`) più l'oggetto `event` che descrive cosa è successo (riga ~3242) — usato dal destinatario per decidere quale notifica/toast mostrare.

### 4.5 Ricezione e merge (`handleIncomingSync`, riga 3294; `mergeById`, riga 3276)
```js
function mergeById(localList, incomingList) {
    const merged = (localList || []).slice();
    (incomingList || []).forEach(incomingItem => {
        const idx = merged.findIndex(item => item.id === incomingItem.id);
        if (idx === -1) merged.unshift(incomingItem);   // nuovo: in cima alla lista
        else merged[idx] = incomingItem;                // esistente: sovrascrive del tutto
    });
    return merged;
}
```
**Importante da sapere**: il merge **non guarda timestamp** — se arriva un oggetto con lo stesso `id`, sovrascrive integralmente la versione locale con quella in arrivo, "ultimo che sincronizza vince". Non c'è risoluzione di conflitto vera; in pratica funziona perché il flusso applicativo (programma → accetta → consenso → firma → completa) è quasi sempre fatto da **un solo lato per volta** per ogni passo, quindi raramente entrambi i lati modificano lo stesso oggetto nello stesso istante.

`handleIncomingSync` gestisce anche tipi speciali di messaggio oltre al generico stato condiviso: `doc_chunk` (trasferimento file a blocchi, sezione 8), `consent_event` (notifiche dal paziente: sblocco OTP, firma), `collab_action` (azioni sulla lavagna). Ogni evento ha un `id`; un `Set` di "eventi processati" evita di mostrare due volte la stessa notifica (capita perché MQTT con QoS 1 può ritrasmettere, o perché il mittente stesso è iscritto al proprio topic e riceve indietro il proprio messaggio — per questo si scarta sempre se `data.sender === S.role`).

### 4.6 Trasferimento file via MQTT a blocchi (`sendDocumentInChunks`, riga 2999)
I broker MQTT pubblici hanno limiti di dimensione payload (e i file in Base64 pesano ~33% più del binario originale). Soluzione: i documenti vengono spezzati in **chunk da 150.000 caratteri**, inviati uno alla volta con **25ms di pausa** tra un chunk e l'altro (per non saturare CPU/broker), ciascuno taggato con `docId`, `chunkIndex`, `totalChunks`. Il ricevente li riassembla in `handleIncomingSync` e mostra una progress bar (`updateDocReceiveProgress`, riga 3028) finché `chunkIndex` raggiunto non è uguale a `totalChunks`.

---

## 5. Ciclo di vita di una televisita

### 5.1 Visita programmata (normale)
1. **`scheduleVisit(e, formVariant)`** (riga 6287): legge il form (`#f-patient`, `#f-date`, ecc.), **controlla conflitti di orario** (stessa data+ora già occupata, escludendo visite completate/rifiutate — righe ~6289-6303), crea l'oggetto visita con `status: 'programmata'`, `consentStatus: 'non-inviato'`, e lo aggiunge in testa a `S.televisite`. Sincronizza con `syncState({kind:'visit_scheduled', ...})`.
2. **`acceptSched(id)` / `rejectSched(id)`** (righe 6396, 6407): l'altra struttura accetta o rifiuta. All'accettazione viene generata la stanza video con `genRoom(id)` e assegnata a `tv.room` — **non è una funzione deterministica/hash dell'id** (vedi nota sotto), il nome stanza viene generato **una sola volta** da chi accetta e poi propagato a tutti tramite la sincronizzazione dello stato (`tv.room` fa parte dell'oggetto visita sincronizzato), non rigenerato indipendentemente sui due lati.
3. **`startVisit(id)`** (riga 6428): possibile solo se `status` è 'accettata'/'in-corso' **e** (`consentStatus === 'firmato'` oppure `tv.type === 'urgente'`). Avvia Jitsi (`launchJitsi`) e marca `status: 'in-corso'`.

> **Dettaglio corretto su `genRoom`** (riga 8287): `function genRoom(seed) { return 'televisita-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,6); }` — il parametro `seed` (l'id della visita) viene passato ma **non è usato dentro la funzione**: il nome stanza è timestamp+random, non un hash deterministico del seed. Se un developer chiede "ma allora come fanno i due lati a finire nella stessa stanza Jitsi se il nome è casuale?" — la risposta corretta è: lo genera **una volta sola** chi accetta la visita, e da lì in poi è un campo (`tv.room`) dell'oggetto visita che viaggia con tutta la sincronizzazione di stato (MQTT + localStorage), non viene ricalcolato dall'altro lato.

### 5.2 Visita urgente/immediata
Flusso diverso e più rapido, pensato per le emergenze, **senza step di consenso preventivo** (`consentStatus` è già `'firmato'` alla creazione, perché l'urgenza prevale e il consenso si considera implicito — coerente con quanto raccontato nella demo guidata):
- `requestImmediate()` / `submitUrgentRequest(event)` (righe 6480, 6574): crea la visita con `status:'in-corso'`, `type:'urgente'`, genera subito una stanza, imposta `S.immReq = 'waiting'`, `S.immRoom`, `S.immReqSender`, e notifica l'altra struttura via `syncState`.
- L'altra struttura vede un banner/notifica con **Accetta/Rifiuta** (`acceptImmediate()`/`rejectImmediate()`, righe 6621/6629).
- `cancelImmediate()` / `resetImmediate()` per annullare la richiesta.

### 5.3 Televisita "Network" vs "Centro" (richiesta dal medico dopo la demo)
Nel form di programmazione (sia per Struttura 1 sia per Struttura 2) è stato aggiunto un selettore **"Tipo di Televisita"** (`#f-visit-mode` / `#f2-visit-mode`, riga ~1324/1442) con due opzioni:
- **Network**: comportamento di sempre — la richiesta va anche all'altra struttura, che deve accettarla prima di poterla avviare.
- **Centro**: la struttura gestisce la televisita **da sola**, senza coinvolgere l'altra struttura. Non c'è nessuna accettazione da attendere: la visita nasce già con `status:'accettata'` e una stanza video propria (`genRoom`), esattamente come se l'altro lato l'avesse già accettata. L'unica condizione che resta per poter cliccare "Avvia" è il **consenso del paziente firmato** (stesso meccanismo OTP di sempre — qui non cambia nulla).

**Nessun valore predefinito, scelta obbligatoria.** Su richiesta esplicita: il `<select>` parte vuoto (`<option value="" selected disabled>`) e ha l'attributo `required` — la struttura deve scegliere consapevolmente Network o Centro ogni volta, non c'è un default che possa essere scelto "per distrazione". `scheduleVisit()` (riga ~6413) ha anche un controllo JS di riserva (mostra un avviso con `showCenteredAlert` e blocca il salvataggio) per il caso in cui la validazione nativa del browser venga aggirata — ma nella pratica è il `required` nativo del browser a bloccare il submit con la sua bolla di validazione standard, prima ancora che la funzione JS venga chiamata.

In `scheduleVisit()` (riga ~6396 col nuovo codice) questo si traduce in poche righe: si legge `visitMode` dal select, e se è `'centro'` si imposta `status:'accettata'` e si genera subito `tv.room`, invece di lasciare `status:'programmata'`/`room:null` come per una visita Network.

**Il punto delicato — la privacy della "Centro" dev'essere reale, non solo visiva.** Le due strutture sono iscritte allo **stesso topic MQTT**, quindi non basta "non mostrare" la visita Centro all'altra struttura: bisogna evitare che ci arrivi anche solo come dato cifrato. Tre punti dove questo viene garantito:
1. **`getShared()`** (la funzione che prepara il payload per MQTT) esclude **del tutto e senza eccezioni** le televisite con `visitMode==='centro'`: `S.televisite.filter(tv => tv.visitMode !== 'centro')`. Restano invece intatte in `getSharedStateForStorage()` (il salvataggio in `localStorage`, puramente locale).
2. I **documenti collegati** (consenso auto-generato, referto firmato, upload manuali) ora portano un campo `tvId` che li lega alla visita. `getShared()` applica lo stesso filtro anche a loro, così nemmeno i loro metadati (nome, paziente) finiscono sul payload MQTT.
3. Il bottone "Condividi" su un documento legato a una televisita Centro **non viene nemmeno mostrato** (`renderDocs`), più un controllo difensivo in `confirmShareDoc()` che blocca comunque la condivisione se invocata.
4. Per coerenza visiva è stata introdotta `visibleTelevisite()` (helper centralizzato), usata in `renderVisits`, `renderSession` (statistiche), `populatePatientFilter`, `renderActiveEMR` e `showStatsDetail`: filtra `S.televisite` lasciando passare solo le visite Network più le proprie Centro. Serve soprattutto perché la **demo su singolo browser** (cambio ruolo con `switchRole()` nella stessa tab) condivide lo stesso array `S.televisite` in memoria tra "Struttura 1" e "Struttura 2": senza questo filtro, passando da un ruolo all'altro nella demo si vedrebbe comunque (in memoria, anche se non sulla rete reale) la Centro dell'altro ruolo.

Una televisita Centro mostra un badge dedicato (`<span class="badge bg-info-subtle...">Centro</span>`, riga vicino a `visitHTML()`) per distinguerla a colpo d'occhio dalle Network nella stessa lista.

**Se un developer chiede "ma quindi le due liste 'Centro' e 'Network' sono separate?"** — no, è deliberatamente la stessa lista/lo stesso array (`S.televisite`), con un campo in più (`visitMode`) e un filtro di visibilità applicato in lettura: niente nuova struttura dati, niente nuova tabella. Minimizza la superficie di modifica e riusa tutta la UI, i bottoni e il flusso di consenso già esistenti.

---

## 6. Consenso informato e OTP (il fiore all'occhiello della demo)

Flusso a **due email/due tappe**, pensato per non far dipendere la firma dal telefono o dal contatto diretto medico-paziente:

1. **Invio consenso** — `sendConsentEmail(id)` (riga 4159): genera l'URL pubblico con `buildPatientConsentUrl()` (riga 4101) e invia (in simulazione e/o realmente, sezione 9) un'email con un link **personale, senza login richiesto**. `consentStatus` passa a `'inviato'`.
2. **Lettura obbligata** — il paziente apre il link, finisce sulla vista pubblica `#patient-consent-overlay` (`initPatientConsentView()`, riga 4364, attivata se `isPatientConsentMode()` rileva il parametro `?consent=1` nell'URL). Il bottone "Accetto" resta disabilitato finché non si scrolla fino in fondo al testo del consenso: `gateButtonUntilScrolledToEnd()` (riga 4200) — un controllo onesto, non un finto blocco solo visivo.
3. **Sblocco OTP** — cliccando "Accetto e sblocca OTP" (`unlockConsentOtp()`, riga 4266 sul lato medico / equivalente lato paziente), viene generato un **OTP a 4 cifre casuale** (`Math.floor(1000 + Math.random()*9000)`), salvato su `tv.consentOtp`, e inviato al paziente come seconda email (e mostrato a video sulla stessa pagina, per i test).
4. **Firma** — il paziente inserisce l'OTP nella stessa pagina pubblica (oppure, in alternativa, lo comunica per telefono al medico che lo digita lui stesso sul cruscotto): `verifyConsentOtp(id)` (riga 4655) confronta il valore inserito con `tv.consentOtp`; se coincide, `consentStatus` diventa `'firmato'` e l'OTP viene azzerato.
5. Il cruscotto medico si aggiorna **da solo**, senza reload, perché la firma genera un evento `consent_event` che arriva via `BroadcastChannel` (se stesso PC) o MQTT cifrato (se PC/struttura diversa) — vedi `publishPatientMqttMessage()` (riga 4515).

### URL pubblico generato (esempio reale di formato, da `buildPatientConsentUrl`)
```
https://.../televisita_fix.html?consent=1&tvId=TV1234567890&room=cervello-tunisia
&name=Mario%20Rossi&email=mario%40email.com&lang=it&pk=...&sid=...&tid=...
```
- `room` serve sia a sottoscrivere il topic MQTT giusto, sia a derivare la chiave AES-GCM per cifrare/decifrare i messaggi che il paziente scambia col cruscotto.
- `pk`/`sid`/`tid` sono le credenziali EmailJS (public key, service id, template id) **passate in chiaro nell'URL** quando configurate, così la pagina pubblica del paziente (che non ha accesso al `localStorage` del medico) può comunque inviare email reali via EmailJS.
- Anti-riuso: `isPatientConsentLinkUsed()`/`markPatientConsentLinkUsed()` (righe 4357/4360) marcano in `localStorage` **del dispositivo del paziente** che quel link è già stato usato — protezione "soft", facilmente bypassabile cambiando browser/dispositivo, perché non c'è un server che revochi il link lato backend (non esiste un backend).

Esistono **altre due viste pubbliche paziente** con lo stesso pattern (overlay fullscreen, niente login, stato letto da query string):
- `isPatientReportMode()` / `initPatientReportView()` (righe 4407/4412): mostra il referto firmato, scaricabile/stampabile.
- `isPatientCallMode()` / `initPatientCallView()` (righe 4447/4452): verifica lo stato della call (`checkCallStatusThenProceed`, riga 4479, legge il topic `.../status` con retain) prima di mostrare il link diretto a Jitsi, per evitare che il paziente entri in una stanza già chiusa.

In tutte e tre, `lockBackgroundForPatientView()` (riga ~4336) nasconde **e rimuove dal flusso del documento** (`display:none`) header/role-bar/dashboard del medico, che restano nel DOM (mai inizializzati in questa modalità) ma non devono influenzare il rendering della pagina pubblica — vedi sezione 11 sul bug recente legato esattamente a questo.

---

## 7. Videochiamata — Jitsi Meet

- `JITSI_DOMAIN = 'jitsi.hamburg.ccc.de'` (riga 2167): un'**istanza pubblica** di Jitsi (gestita dal Chaos Computer Club di Amburgo), non un server Jitsi proprietario dell'azienda. Caricata via `<script src="https://jitsi.hamburg.ccc.de/external_api.js" onerror="window._jitsiUnavailable=true">`.
- `launchJitsi(roomName)` (riga 6641): se `JitsiMeetExternalAPI` non è definita o `window._jitsiUnavailable` è true (lo script non si è caricato, es. dominio bloccato da un firewall), mostra un **fallback**: un link diretto `https://jitsi.hamburg.ccc.de/<roomName>` da apire in una nuova tab, invece dell'iframe integrato.
- `endCall()` (riga 6718): chiude l'iframe (`S.jitsiApi.dispose()`) e pubblica lo stato `'ended'` con `retain:true` sul topic di stato (sezione 4.2), così chi apre il link dopo sa che la call è finita.
- La cartella clinica del paziente (note, dati anagrafici, documenti) resta visibile **a fianco** della videochiamata, non in un'altra schermata (`renderActiveEMR`, riga 6925) — è un requisito di usabilità clinica esplicito nel manuale utente.

---

## 8. Documenti clinici e lavagna collaborativa

### 8.1 Documenti (righe 4681-5400)
Ogni documento ha: `id`, `name`, `ext`, `size`, `by` (chi l'ha caricato), `at` (timestamp), `patient`, `category` (consenso/diagnostica/referto, derivata da `getDocCategory()`), `shared` (bool: visibile anche all'altra struttura o solo "bozza locale"), `base64Data`.
- **Bozze locali vs Condivisi**: appena caricato, `shared` è `false` finché il medico non clicca "Condividi" — permette di correggere un upload sbagliato prima che l'altra struttura lo veda.
- Quando si condivide, `syncState()` manda l'evento e (se c'è `base64Data`) avvia `sendDocumentInChunks()` (sezione 4.6) verso l'altra struttura.
- `viewDocPreview(id)` (riga 4984) gestisce l'anteprima (PDF via pdf.js, immagini dirette).

### 8.2 Lavagna collaborativa (righe 5400-6088)
- `toggleCollaboration(docId)` / `openLocalCollabBoard(docId)` (righe 5447, 5539): apre un canvas sopra al render del PDF (via pdf.js, libreria locale per i motivi spiegati in sezione 0) o dell'immagine.
- Disegno: `startCollabDraw`/`collabDraw`/`stopCollabDraw` (righe 5785-5833) catturano i tratti del mouse, `drawOnCanvas()` li disegna localmente; in parallelo i segmenti vengono accodati e spediti via MQTT (`flushPendingDrawSegments`, riga 5872) come azioni `collab_action`, così l'altro medico vede gli stessi tratti apparire sul proprio canvas in tempo reale.
- `changeCollabZoom()` (riga 5617) sincronizza anche il livello di zoom tra i due lati (altrimenti le coordinate del disegno non corrisponderebbero più tra schermi con zoom diverso).
- `downloadAnnotatedDoc(docId)` (riga 5909, con `mergeAndDownload()` interna) fonde canvas annotato + documento originale in un unico file scaricabile.
- `clearCollabBoard(sendSync)` (riga 6068) pulisce la lavagna, sincronizzandolo o no in base al parametro.
- C'è anche una **simulazione ECG animata** (`startEcgSimulation`, riga 6088, con `animate()` interna) — un tracciato finto disegnato su canvas per scopi demo/dimostrativi, non dati reali da un dispositivo.

---

## 9. Email: simulata + reale (EmailJS opzionale)

- **Di default**: ogni email (consenso, OTP, invito video, referto) viene generata come oggetto JS e infilata in `S.emails` (`addSimulatedEmail()`, riga 3868) — è la "casella email simulata del paziente" visibile dall'icona busta in alto nel cruscotto, pensata per fare demo/test **senza dover davvero ricevere email**.
- **Email reali (opzionale)**: se il medico apre l'icona ingranaggio (`openEmailSettingsModal()`, riga 3991) e inserisce **Public Key / Service ID / Template ID** di un account EmailJS (`saveEmailSettings()`, riga 4012, salva in `localStorage` chiave `tv_emailjs_config`), allora `addSimulatedEmail()` *in aggiunta* alla simulazione chiama `emailjs.send(...)` per spedire davvero l'email al paziente.
- `sendMailtoDirect(id)` (riga 3941): scorciatoia che apre il client di posta di default del medico (link `mailto:`) come alternativa manuale.
- *(Nota di contesto personale: due caselle email "vere" delle due strutture non sono ancora configurate — nel frattempo si testa con un indirizzo email personale, vedi promemoria già in memoria di progetto.)*

---

## 10. Codice Fiscale italiano e CIN tunisino

- `calculateItalianCF(fullName, dobStr, gender, pobStr)` (riga 6759) implementa davvero le regole del Codice Fiscale italiano: estrazione consonanti/vocali da nome e cognome (`getConsonantsAndVowels()`, interna), codifica mese su lettera, giorno+40 per le donne, e carattere di controllo finale.
- `autoCalculateCF(pfx)` (riga 6850) lo richiama dal form quando si seleziona "Codice Fiscale (Italia)" come tipo identificativo e tutti i dati necessari sono presenti.
- `generateMockCF(name)` (riga 6747) genera invece un codice fittizio a 8 cifre per il CIN tunisino (non esiste un algoritmo ufficiale implementato, è un mock coerente solo per la demo).
- `toggleIdField(pfx)` (riga 6895) mostra/nasconde il campo codice in base al tipo scelto (CF/CIN/nessuno).

---

## 11. Dettaglio recente: bug del referto stampato (utile per dimostrare di conoscere la storia del progetto)

Ultimo commit (`718b10c`): il referto firmato, quando il paziente lo stampava o salvava come PDF dal link pubblico, generava pagine bianche extra e talvolta un testo rimpicciolito.

**Causa reale**: la dashboard del medico restava nel DOM dietro l'overlay pubblico del paziente — `lockBackgroundForPatientView()` la nascondeva solo visivamente (`overflow:hidden`), senza togliarla dal **flusso** del documento. In stampa, l'altezza reale della dashboard (anche se invisibile) si sommava a quella del referto, e il browser produceva pagine vuote in più, oppure scalava tutto per farlo entrare in una pagina sola (da cui il testo piccolo).

**Fix**: 
1. In CSS, durante la stampa, `#patient-report-overlay` torna `position: static` (non più `fixed`) e il suo contenitore perde `min-height:100vh`, così occupa solo l'altezza reale del referto.
2. In JS, `lockBackgroundForPatientView()` ora aggiunge anche `display:none` a `.app-header`, `.role-bar`, `.container-xl` — rimuovendoli completamente dal flusso, non solo dalla vista, in qualunque modalità pubblica paziente (consenso, referto, call).

---

## 12. Demo guidata (`runDemo`, riga 8143)

Tour automatico passo-passo (29 step totali, costante `TOTAL`), pensato per mostrare l'app a chi non l'ha mai vista senza dover cliccare manualmente:
- Usa `scheduleDemo(delayMs, callback)` per accodare gli step nel tempo (i delay vanno da 0 a decine di secondi, calibrati per essere leggibili a voce alta durante una demo dal vivo).
- `showDemoGuide(step, total, titleIT, titleFR, bodyIT, bodyFR)` mostra il pannello fisso in basso a destra (`#demo-guide-panel`) con barra di progresso, testo bilingue scelto in base a `currentLang`.
- `highlightDemoEl(selector)` evidenzia l'elemento UI rilevante per quel passo.
- Il tour copre **tre percorsi in sequenza**: (1) la televisita **Network normale** completa (programmazione → accettazione dell'altra struttura → invio consenso → lettura/scroll/OTP del paziente → firma → videochiamata → referto firmato → consegna al paziente); (2) la televisita **urgente** (richiesta immediata → accettazione rapida → consenso auto-firmato → videochiamata); (3) la televisita **Centro** (stesso form ma con "Tipo di Televisita" su Centro → nessuna attesa di accettazione, ma stesso consenso con OTP del percorso normale → videochiamata → mai apparsa sul cruscotto dell'altra struttura). Il terzo percorso (step 22-29) resta sul ruolo Struttura 2 senza un ulteriore cambio di profilo, per varietà.
- Pazienti fittizi: **Maria Esposito** (Network, con note cliniche di esempio `DEMO_NOTES_IT`/`DEMO_NOTES_FR`), **Luca Bianchi** (urgente), **Sara Greco** (Centro).
- `stopDemo()` viene chiamato in testa a `runDemo()` per azzerare un'eventuale demo già in corso prima di ripartire.
- **Linguaggio volutamente non tecnico**: i testi della demo non menzionano MQTT, broker, server o crittografia — parlano solo di "sincronizzazione in tempo reale" e "cruscotto". Il pubblico di riferimento (medici) non ha bisogno di sapere come funziona sotto il cofano; quei dettagli restano in questo documento di studio, non nella UI rivolta a loro.
- **Insidia tecnica da ricordare se si tocca ancora la demo**: la card di ogni televisita viene renderizzata con lo stesso HTML in entrambi i pannelli `vlist-s1`/`vlist-s2` (vedi `renderVisits`, sezione 12 del codice), quindi id come `otp-input-{tvId}` sono **duplicati nel DOM**. Un semplice `document.getElementById('otp-input-...')` prende sempre il primo (quello dentro `p-s1`) indipendentemente dal ruolo attivo — innocuo quando il passo demo gira su Struttura 1 (e infatti il percorso Network/urgente non se ne accorge), ma rompe la verifica OTP se il passo gira su Struttura 2 (il caso del percorso Centro). Va sempre scoperto il pannello giusto prima, esattamente come fa `verifyConsentOtp()` internamente: `document.getElementById(S.role === 'struttura1' ? 'p-s1' : 'p-s2').querySelector('#otp-input-' + id)`.

---

## 13. Cose oneste da sapere (per non farsi cogliere in fallo)

Se un developer fa domande "trabocchetto", queste sono le risposte corrette e dirette, senza vendere fumo:

| Domanda probabile | Risposta onesta |
|---|---|
| "C'è un backend?" | No. Tutto client-side: `localStorage` + MQTT pub/sub su broker pubblico. Nessun database, nessuna API REST proprietaria. |
| "I dati sono cifrati end-to-end davvero?" | Sì con AES-GCM-256 via Web Crypto, quando il browser è in contesto sicuro (HTTPS/localhost); fallback XOR altrimenti. La chiave deriva da SHA-256 del "codice stanza" — protegge da osservatori passivi sul broker pubblico, non è un sistema di key management enterprise. |
| "Cosa impedisce a chiunque di sottoscrivere lo stesso topic MQTT?" | Niente a livello di broker (è pubblico): la protezione è che, senza conoscere il `roomCode`, non si può derivare la chiave e i messaggi restano cifrati/illeggibili. |
| "Le email sono vere?" | Di default sono simulate in una "casella" interna per demo/test. Diventano vere solo se si configurano le credenziali EmailJS nelle impostazioni. |
| "La firma del consenso ha valore legale?" | È un flusso OTP via email a due tappe con scroll obbligato del testo, robusto come UX, ma non è una firma elettronica qualificata (no PKI/certificati, no marca temporale di un ente terzo). Tecnicamente è una firma elettronica semplice. |
| "Cosa succede se due medici modificano la stessa visita in contemporanea da PC diversi?" | Vince l'ultimo che sincronizza: il merge è per `id`, sovrascrive senza guardare timestamp. Non c'è vera risoluzione di conflitti, ma il flusso applicativo rende la cosa rara in pratica. |
| "Perché Jitsi pubblico e non un server proprio?" | Scelta pragmatica per il prototipo/demo: zero infrastruttura da gestire, fallback a link diretto se il dominio non è raggiungibile. |
| "Il codice fiscale è calcolato correttamente?" | Sì per l'Italia, segue le regole reali (consonanti/vocali, mese a lettera, +40 giorni per le donne, carattere di controllo). Per la Tunisia (CIN) è un mock, non un algoritmo ufficiale. |
| "Perché pdf.js è locale e non da CDN?" | Per non dipendere da un CDN esterno che potrebbe essere bloccato da un firewall ospedaliero — eviterebbe che il rendering PDF fallisca in modo asimmetrico tra i due lati della lavagna collaborativa. |
| "Una televisita 'Centro' è davvero invisibile all'altra struttura, o solo nascosta in UI?" | È esclusa anche dal payload MQTT (non solo dal rendering): `getShared()` la filtra via prima di pubblicare, quindi l'altra struttura non riceve nemmeno il dato cifrato. Lo stesso vale per i documenti collegati (consenso, referto). |
| "C'è gestione degli errori/retry sulla connessione MQTT?" | Sì, timeout di 5s e fallback automatico su una lista di 3 broker pubblici (EMQX, HiveMQ, Mosquitto). Non c'è invece un avviso esplicito al medico se *tutti* i broker falliscono: l'app resta usabile in locale ma senza sync con l'altra struttura. |

### 13.1 Domande tecniche molto specifiche che possono sorgere

Queste sono risposte che valgono anche se qualcuno ti fa una domanda “più precisa del normale” e ti prova a mettere in difficoltà:

1. **“Perché non si usa un backend per salvare tutto?”**  
   Perché il requisito era che l'app potesse girare anche come pagina statica o da file locale, senza infrastruttura server. Il backend non è assente per comodità: è assente perché il progetto è stato progettato per una modalità operativa semplice, portabile e veloce da distribuire in ambiente clinico.

2. **“Se il broker MQTT è pubblico, come fa a non essere leggibile da chiunque?”**  
   Il broker vede solo pacchetti cifrati. La chiave non viene scambiata su rete: si deriva dal `roomCode` (codice stanza), quindi anche se un osservatore legge i messaggi, non può decifrarli senza conoscere il codice stanza usato nella sessione.

3. **“Che succede se il `roomCode` viene condiviso per errore?”**  
   In pratica si perde la protezione del traffico: chi conosce il codice può derivare la stessa chiave e leggere i messaggi. Quindi il `roomCode` è una parte critica della sicurezza del sistema, ma non un segreto forte come una password enterprise.

4. **“Come si evita che due lati facciano due stanze Jitsi diverse?”**  
   La stanza non viene ricalcolata da ogni lato. Una volta che chi accetta la visita genera il nome della stanza, quel valore viene salvato dentro l'oggetto visita (`tv.room`) e propagato via sincronizzazione dello stato. L'altro lato lo riceve e lo usa.

5. **“Che differenza c'è tra `getShared()` e `getSharedStateForStorage()`?”**  
   `getSharedStateForStorage()` salva tutto, incluso `base64Data` dei file, perché serve a ricostruire lo stato locale completo. `getShared()` invece elimina i file binari e i dati privati non destinati all'altra struttura, perché il payload MQTT deve essere più leggero e meno sensibile.

6. **“Come viene gestito un file grande, come un PDF pesante?”**  
   Il documento viene spezzato in chunk da circa 150.000 caratteri, inviato a blocchi con pausa tra un chunk e l'altro, e ricomposto lato ricevente. È una soluzione pratica per non superare i limiti del broker e del browser.

7. **“Cosa succede se si apre la pagina in due tab sullo stesso PC?”**  
   È gestito da `BroadcastChannel('televisita_sync')`. La tab principale sincronizza subito le altre tab dello stesso browser, quindi non serve aspettare MQTT per vedere lo stato aggiornato.

8. **“Se il medico cancella la cache, perde tutto?”**  
   Sì, perde la copia locale dello stato. Non c'è backup centralizzato. Il punto importante è che il sistema è progettato per essere resiliente ai refresh ma non per essere una fonte di verità centralizzata.

9. **“La firma del consenso è davvero una firma elettronica?”**  
   Da un punto di vista UX e procedurale è un flusso robusto con OTP e obbligo di scroll; tecnicamente è una firma elettronica semplice, non una firma qualificata con certificazione di terze parti.

10. **“Qual è il limite reale del modello attuale?”**  
   Il limite principale è la gestione della consistenza e della sicurezza in produzione: non c'è un server di autorizzazione, non c'è un database centralizzato, non c'è un key-management avanzato e il merge dello stato si basa su regole di business semplici. È ottimo per prototipo/demo e per ambienti controllati, meno per un deployment enterprise con requisiti normativi forti.

---

## 14. Mappa rapida funzioni → righe (cheat sheet)

| Area | Funzione chiave | Riga circa |
|---|---|---|
| i18n | `t()`, `applyTranslations()`, `changeLang()` | 2682-2753 |
| Stato/struttura | `S`, `FACILITIES`, `DOCTORS` | 2756-2809 |
| Crittografia | `getCryptoKey`, `encryptPayload`, `decryptPayload`, `xorEncryptDecryptBytes` | 2895-2992 |
| Chunk file | `sendDocumentInChunks`, `updateDocReceiveProgress` | 2999-3037 |
| MQTT | `sendMQTTMessage`, `publishCallStatus`, `initMQTT`, `tryNextBroker` | 3040-3220 |
| Sync stato | `syncState`, `loadSharedState`, `mergeById`, `handleIncomingSync` | 3221-3517 |
| Login | `selectFacility`, `sha256Fallback`, `submitLogin`, `logout` | 3526-3697 |
| Render | `renderAll`, `renderVisits`, `visitHTML`, `consentSectionHTML` | 3731-3868 |
| Email | `addSimulatedEmail`, `openEmailSettingsModal`, `saveEmailSettings` | 3868-4024 |
| Backup | `exportDataBackup`, `importDataBackup` | 4024-4101 |
| Consenso/OTP | `buildPatientConsentUrl`, `sendConsentEmail`, `unlockConsentOtp`, `verifyConsentOtp` | 4101-4681 |
| Vista pubblica consenso | `initPatientConsentView`, `isPatientConsentLinkUsed` | 4336-4401 |
| Vista pubblica referto | `initPatientReportView` | 4406-4440 |
| Vista pubblica call | `initPatientCallView`, `checkCallStatusThenProceed` | 4440-4642 |
| Documenti | `renderDocs`, `buildReportCardHtml`, `viewDocPreview` | 4681-5400 |
| Lavagna collaborativa | `toggleCollaboration`, `initCollabCanvas`, `drawOnCanvas`, `downloadAnnotatedDoc` | 5400-6088 |
| ECG demo | `startEcgSimulation` | 6088-6189 |
| Ciclo visita | `scheduleVisit`, `acceptSched`, `rejectSched`, `startVisit` | 6287-6477 |
| Visita urgente | `requestImmediate`, `acceptImmediate`, `rejectImmediate` | 6480-6636 |
| Jitsi | `launchJitsi`, `endCall` | 6641-6744 |
| Codice Fiscale | `calculateItalianCF`, `autoCalculateCF` | 6747-6925 |
| Cartella clinica | `renderActiveEMR`, `saveEMRNotes`, `simulateVoiceDictation` | 6925-7292 |
| Firma medico | `openDoctorSignatureModal`, `initSignatureCanvas`, referto+verifica | 7324-7509 |
| Demo guidata | `runDemo`, `showDemoGuide`, `highlightDemoEl` | 8034-8282 |
| Utility | `genRoom`, `fmtDate`, `fmtSize`, `statusInfo` | 8284-8320 |

---

## 15. Frase di apertura suggerita per la presentazione

> "È una piattaforma di televisita pensata per funzionare senza alcuna infrastruttura server: tutto lo stato vive nel browser delle due strutture, e la sincronizzazione in tempo reale passa per un broker MQTT pubblico, con i dati cifrati end-to-end con AES-GCM prima di lasciare il dispositivo — quindi anche se il canale è pubblico, nessun intermediario può leggere i contenuti clinici. Il flusso copre tutto il percorso clinico: programmazione della visita, coordinamento tra le due strutture, consenso informato firmato dal paziente con OTP via email, videoconsulenza integrata con cartella clinica affiancata, condivisione documenti e lavagna collaborativa in tempo reale su immagini diagnostiche, fino al referto firmato e consegnato al paziente."

Da lì, lasciare che le domande guidino l'approfondimento — con questo documento come riferimento per i dettagli precisi (numeri di riga, nomi di funzione, scelte tecniche).
