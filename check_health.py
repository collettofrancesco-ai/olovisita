#!/usr/bin/env python3
"""Controlli di salute rapidi per Olovisita, da lanciare prima di un push importante:
traduzioni IT/FR complete, sintassi JavaScript valida, struttura di FACILITIES (utenti) e
DEFAULT_EMAILJS_CONFIGS coerente (campi obbligatori, nessuno username duplicato, passwordHash
nel formato atteso), e build pubblicata (docs/index.html) davvero sincronizzata col sorgente
e online su GitHub Pages.

Uso: python3 check_health.py
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent
SRC = ROOT / "televisita_fix.html"
DIST = ROOT / "docs" / "index.html"
GH_REPO = "collettofrancesco-ai/olovisita"

# manage_users.py e manage_emailjs.py modificano il sorgente con regex "chirurgiche" (isolano
# un blocco per parentesi bilanciate, sostituiscono la riga), non con un vero parser JS: un edit
# imprevisto potrebbe lasciare il sorgente in uno stato incoerente senza che nulla lo segnali
# finché il sito non si rompe in produzione. Si importano qui le loro funzioni di lettura (mai
# quelle di scrittura) per riusare la STESSA logica di ricerca nel sorgente usata dagli script
# che lo modificano, invece di duplicarla con il rischio che le due copie divergano nel tempo.
sys.path.insert(0, str(ROOT))
import manage_users
import manage_emailjs

REQUIRED_USER_FIELDS = ["username", "name", "spec", "avatar", "color", "bg", "passwordHash"]


def extract_lang_block(text, lang, start_from=0):
    """Estrae il testo di LANGS.<lang> = { ... } contando le parentesi: alcuni valori
    contengono `{` e `}` dentro l'HTML (es. <strong>...</strong> con altre parentesi annidate),
    quindi una regex senza bilanciamento rischierebbe di fermarsi alla chiusura sbagliata."""
    marker = re.search(r"\b" + lang + r":\s*\{", text[start_from:])
    if not marker:
        raise ValueError(f"Non trovo il blocco LANGS.{lang} nel sorgente.")
    start = start_from + marker.end() - 1
    depth = 0
    i = start
    while i < len(text):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
        i += 1
    raise ValueError(f"Parentesi non bilanciate nel blocco LANGS.{lang}.")


def extract_keys(block_text):
    # I valori possono essere tra virgolette singole, doppie o backtick (stringhe multilinea
    # con markup HTML, es. pdf_consent_body): vanno riconosciute tutte e tre le forme.
    return set(re.findall(r"(?m)^\s*([a-zA-Z_][a-zA-Z0-9_]*):\s*[\"'`]", block_text))


def extract_used_keys(text):
    # Trova solo gli usi STATICI (chiave scritta letteralmente nel codice). Chiavi costruite
    # dinamicamente (es. 'spec_' + qualcosa.toLowerCase()) non possono essere viste da un
    # controllo a regex: è un limite noto di questo script, non una garanzia di completezza assoluta.
    used = set()
    used |= set(re.findall(r"\bt\(\s*['\"]([a-zA-Z_][a-zA-Z0-9_]*)['\"]", text))
    used |= set(re.findall(r'data-i18n(?:-holder)?="([a-zA-Z_][a-zA-Z0-9_]*)"', text))
    return used


def check_translations(text):
    print("=== Controllo traduzioni IT/FR ===")
    anchor = re.search(r"const\s+LANGS\s*=\s*\{", text)
    if not anchor:
        print("❌ Non trovo l'oggetto LANGS nel sorgente: controllo annullato.")
        return False

    it_keys = extract_keys(extract_lang_block(text, "it", anchor.start()))
    fr_keys = extract_keys(extract_lang_block(text, "fr", anchor.start()))
    used_keys = extract_used_keys(text)

    missing_in_it = sorted(used_keys - it_keys)
    missing_in_fr = sorted(used_keys - fr_keys)
    unused = sorted((it_keys | fr_keys) - used_keys)

    print(f"Chiavi usate nel codice (trovate staticamente): {len(used_keys)}")
    print(f"Chiavi definite in IT: {len(it_keys)} — in FR: {len(fr_keys)}")
    print()

    if missing_in_it:
        print(f"❌ Usate ma MAI definite in italiano ({len(missing_in_it)}) — comparirebbe il nome grezzo della chiave a schermo:")
        for k in missing_in_it:
            print(f"   - {k}")
    else:
        print("✅ Nessuna chiave usata manca dalla lista italiana.")

    print()
    if missing_in_fr:
        print(f"⚠️  Usate ma MAI definite in francese ({len(missing_in_fr)}) — chi usa l'app in francese vedrebbe il testo italiano al loro posto:")
        for k in missing_in_fr:
            print(f"   - {k}")
    else:
        print("✅ Nessuna chiave usata manca dalla lista francese.")

    print()
    print(f"ℹ️  Chiavi definite ma non trovate in uso da nessuna parte: {len(unused)}")
    print("   (non è necessariamente un problema: alcune chiavi vengono costruite dinamicamente nel")
    print("   codice — es. 'spec_' + qualcosa — e questo controllo statico non riesce a vederle.)")

    return not missing_in_it  # solo le mancanze in IT sono davvero bloccanti


def run(cmd):
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)


def check_build_and_deploy():
    print("\n=== Controllo build + pubblicazione ===")

    before = DIST.read_text(encoding="utf-8") if DIST.exists() else None
    print("Ricostruisco docs/index.html dal sorgente attuale...")
    result = run([sys.executable, "build_minified.py"])
    if result.returncode != 0:
        print("❌ La build è FALLITA:")
        print(result.stderr)
        return False
    print(result.stdout.strip())

    after = DIST.read_text(encoding="utf-8")
    if before != after:
        print("⚠️  docs/index.html NON era aggiornato rispetto al sorgente: l'ho appena rigenerato ora.")
        print("   Ricordati di fare commit + push di questa modifica.")
    else:
        print("✅ docs/index.html era già perfettamente sincronizzato col sorgente.")

    git_status = run(["git", "status", "--short"]).stdout.strip()
    if git_status:
        print("\nℹ️  Ci sono modifiche locali non ancora committate:")
        print(git_status)
    else:
        print("\n✅ Nessuna modifica locale in sospeso.")

    unpushed = run(["git", "log", "--oneline", "origin/main..HEAD"]).stdout.strip()
    if unpushed:
        print("\n⚠️  Ci sono commit locali non ancora pubblicati (git push):")
        print(unpushed)
    else:
        print("✅ Tutti i commit locali sono già stati pubblicati su GitHub.")

    print("\nControllo lo stato della pubblicazione su GitHub Pages...")
    # L'endpoint /pages/builds/latest a volte resta "indietro" per diversi minuti rispetto alla
    # situazione reale (verificato il 25/06/2026). In origine si guardava invece il workflow
    # automatico "pages build and deployment" — ma dall'introduzione di
    # .github/workflows/deploy.yml (inizio luglio 2026, deploy via actions/deploy-pages@v4),
    # quel workflow automatico ha smesso del tutto di essere eseguito: la sua ultima run risale
    # a settimane fa, quindi controllarlo dava un esito congelato e sbagliato indipendentemente
    # da cosa succedesse davvero (scoperto il 16/08/2026 mentre si estendeva questo script).
    # Il segnale giusto è ORA il workflow che pubblica per davvero: "Test & Deploy GitHub Pages"
    # (deploy.yml) — lo stesso che il job "deploy" al suo interno esegue solo se i test passano.
    gh_result = run([
        "gh", "run", "list", "--repo", GH_REPO,
        "--workflow=deploy.yml", "--limit", "1",
        "--json", "headSha,status,conclusion"
    ])
    if gh_result.returncode != 0:
        print("❌ Non sono riuscito a contattare GitHub (serve 'gh auth login' e una connessione attiva):")
        print(gh_result.stderr.strip())
        return False

    runs = json.loads(gh_result.stdout)
    local_head = run(["git", "rev-parse", "HEAD"]).stdout.strip()

    if not runs:
        print("⚠️  Nessuna esecuzione del workflow di pubblicazione trovata.")
        return True

    latest = runs[0]
    deployed_sha = latest.get("headSha")
    run_status = latest.get("status")
    conclusion = latest.get("conclusion")

    if run_status != "completed":
        print(f"⚠️  La pubblicazione è ancora in corso (stato: {run_status}): aspetta qualche minuto e riprova.")
    elif conclusion != "success":
        # Bug corretto qui (16/08/2026): questo ramo stampava l'errore ma la funzione ritornava
        # comunque True subito dopo, quindi main() diceva "Tutto a posto" pure con la
        # pubblicazione fallita — proprio il tipo di incidente (deploy bloccato dai test E2E,
        # nessun avviso nell'app) capitato con lo stesso script pensato per scoprirlo.
        print(f"❌ L'ultima pubblicazione è FALLITA (esito: {conclusion}). Controlla su GitHub cosa è andato storto.")
        return False
    elif deployed_sha == local_head:
        print("✅ Il sito pubblicato corrisponde esattamente all'ultimo commit locale.")
    else:
        print(f"⚠️  L'ultima pubblicazione riuscita riguarda un commit diverso da quello locale (online: {deployed_sha[:8]}, locale: {local_head[:8]}).")
        print("   Probabilmente c'è un push recente non ancora arrivato qui, o viceversa.")

    return True


def check_js_syntax(text):
    print("\n=== Controllo sintassi JavaScript ===")
    scripts = re.findall(r"<script(?![^>]*src)[^>]*>(.*?)</script>", text, re.S)
    if not scripts:
        print("❌ Non trovo nessun blocco <script> inline nel sorgente.")
        return False
    js = max(scripts, key=len)
    tmp = ROOT / ".tmp_syntax_check.js"
    tmp.write_text(js, encoding="utf-8")
    try:
        result = subprocess.run(["node", "--check", str(tmp)], capture_output=True, text=True)
    finally:
        tmp.unlink(missing_ok=True)
    if result.returncode != 0:
        print("❌ Errore di sintassi JavaScript:")
        print(result.stderr.strip())
        return False
    print("✅ Sintassi JavaScript corretta (node --check).")
    return True


def check_facilities_structure(text):
    print("\n=== Controllo struttura utenti (FACILITIES) ===")
    all_users = []  # (facility, obj_text, fields)
    for facility in manage_users.FACILITY_LABELS:
        for obj_text in manage_users.get_users_raw(text, facility):
            fields = {f: manage_users.extract_field(obj_text, f) for f in REQUIRED_USER_FIELDS}
            all_users.append((facility, obj_text, fields))

    if not all_users:
        print("❌ Non trovo nessun utente in FACILITIES: controllo annullato.")
        return False
    print(f"Utenti trovati: {len(all_users)}")

    ok = True

    # Campi obbligatori mancanti o vuoti: manage_users.py li lascia vuoti così com'erano se non
    # forniti, quindi un campo mancante nel sorgente non è per forza un errore DI manage_users.py,
    # ma è comunque un dato incompleto da correggere prima che causi problemi (es. login con
    # nome vuoto, o un avatar che non si carica).
    problems = [
        f"[{manage_users.FACILITY_LABELS[facility]}] {fields.get('username') or obj_text[:50]}: mancano {', '.join(missing)}"
        for facility, obj_text, fields in all_users
        if (missing := [f for f in REQUIRED_USER_FIELDS if not fields.get(f)])
    ]
    if problems:
        ok = False
        print(f"❌ Utenti con campi mancanti o vuoti ({len(problems)}):")
        for p in problems:
            print(f"   - {p}")
    else:
        print("✅ Tutti gli utenti hanno i campi obbligatori.")

    # Username duplicati: manage_users.py (reset_password/remove_user/edit_user_info) cerca per
    # username in TUTTO il sorgente, non per struttura — un duplicato (anche tra strutture
    # diverse) farebbe agire sull'utente sbagliato senza alcun avviso.
    seen = {}
    dup_ok = True
    for facility, _, fields in all_users:
        u = fields.get("username")
        if not u:
            continue
        if u in seen and seen[u] != facility:
            dup_ok = False
            print(f"❌ Username duplicato tra strutture: '{u}' compare sia in {manage_users.FACILITY_LABELS[seen[u]]} sia in {manage_users.FACILITY_LABELS[facility]}.")
        elif u in seen:
            dup_ok = False
            print(f"❌ Username duplicato nella stessa struttura: '{u}' compare più volte in {manage_users.FACILITY_LABELS[facility]}.")
        else:
            seen[u] = facility
    if dup_ok:
        print("✅ Nessuno username duplicato.")
    else:
        ok = False

    # passwordHash: deve essere un hash SHA-256 esadecimale (64 caratteri) — un valore troncato
    # o corrotto farebbe fallire silenziosamente ogni login per quell'utente, senza errore visibile.
    bad_hash = [f["username"] for _, _, f in all_users if f.get("passwordHash") and not re.fullmatch(r"[0-9a-f]{64}", f["passwordHash"])]
    if bad_hash:
        ok = False
        print(f"❌ passwordHash con formato sospetto (non 64 caratteri esadecimali): {', '.join(bad_hash)}")
    else:
        print("✅ Tutti i passwordHash hanno il formato atteso (64 caratteri esadecimali).")

    return ok


def check_emailjs_structure(text):
    print("\n=== Controllo struttura EmailJS (DEFAULT_EMAILJS_CONFIGS) ===")
    ok = True
    for facility, label in manage_emailjs.FACILITIES.items():
        try:
            items = manage_emailjs.get_items(text, facility)
        except ValueError as e:
            ok = False
            print(f"❌ [{label}] {e}")
            continue
        if not items:
            ok = False
            print(f"❌ [{label}] catena EmailJS vuota: la struttura non potrebbe inviare email.")
            continue
        bad = [
            (it[:60], missing)
            for it in items
            if (missing := [f for f in ("publicKey", "serviceId", "templateId") if not re.search(r"\b" + f + r":\s*'[^']+'", it)])
        ]
        if bad:
            ok = False
            print(f"❌ [{label}] account EmailJS con campi mancanti ({len(bad)}):")
            for snippet, missing in bad:
                print(f"   - manca {', '.join(missing)} in: {snippet}...")
        else:
            print(f"✅ [{label}] {len(items)} account EmailJS, tutti con i campi richiesti.")
    return ok


def main():
    print("=== Controllo di salute Olovisita ===")
    print("1) Controllo traduzioni IT/FR")
    print("2) Controllo sintassi JavaScript")
    print("3) Controllo struttura utenti (FACILITIES)")
    print("4) Controllo struttura EmailJS (DEFAULT_EMAILJS_CONFIGS)")
    print("5) Verifica build + pubblicazione")
    print("6) Tutti")
    choice = input("Scegli (1/2/3/4/5/6): ").strip()
    if choice not in ("1", "2", "3", "4", "5", "6"):
        sys.exit("Scelta non valida.")

    text = SRC.read_text(encoding="utf-8")

    ok = True
    if choice in ("1", "6"):
        ok = check_translations(text) and ok
    if choice in ("2", "6"):
        ok = check_js_syntax(text) and ok
    if choice in ("3", "6"):
        ok = check_facilities_structure(text) and ok
    if choice in ("4", "6"):
        ok = check_emailjs_structure(text) and ok
    if choice in ("5", "6"):
        ok = check_build_and_deploy() and ok

    print("\n" + ("✅ Tutto a posto." if ok else "❌ Ci sono problemi da controllare (vedi sopra)."))


if __name__ == "__main__":
    main()
