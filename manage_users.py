#!/usr/bin/env python3
"""Aggiunge un nuovo utente medico o resetta la password di uno esistente, partendo dal
codice generato dal pannello admin (?admin=1) di Olovisita, senza dover modificare il
sorgente a mano: applica la modifica a televisita_fix.html, ricostruisce docs/index.html
e (a richiesta) fa commit e push.

Uso: python3 manage_users.py
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent
SRC = ROOT / "televisita_fix.html"

FACILITY_LABELS = {
    "struttura1": "Centro Tunisia",
    "struttura2": "Ospedale Vincenzo Cervello",
}


def extract_username(code_line):
    m = re.search(r"username:\s*'([^']*)'", code_line)
    return m.group(1) if m else None


def add_new_user(text, facility, code_line):
    """Aggiunge code_line in coda a FACILITIES[facility].users. Restituisce il nuovo testo."""
    username = extract_username(code_line)
    if not username:
        raise ValueError("Non trovo lo username nel codice incollato.")

    pattern = re.compile(
        r"(" + re.escape(facility) + r":\s*\{.*?users:\s*\[)(.*?)(\n(\s*)\])",
        re.S,
    )
    match = pattern.search(text)
    if not match:
        raise ValueError(f"Non trovo l'elenco utenti di {facility} nel sorgente.")

    existing_block = match.group(2)
    if f"username: '{username}'" in existing_block:
        raise ValueError(f"Esiste già un utente con username '{username}' in {facility}.")

    closing_indent = match.group(4)
    item_indent = closing_indent + " " * 4

    new_block = existing_block.rstrip()
    if new_block and not new_block.rstrip().endswith(","):
        new_block += ","
    new_block += "\n" + item_indent + code_line.strip().rstrip(",")

    new_text = text[: match.start(2)] + new_block + text[match.end(2):]
    return new_text, username


def reset_password(text, code_line):
    """Sostituisce la riga esistente con lo stesso username con code_line, in qualunque
    struttura si trovi. Restituisce il nuovo testo."""
    username = extract_username(code_line)
    if not username:
        raise ValueError("Non trovo lo username nel codice incollato.")

    line_pattern = re.compile(
        r"[ \t]*\{[^\n]*username:\s*'" + re.escape(username) + r"'[^\n]*\},?[ \t]*\n"
    )
    match = line_pattern.search(text)
    if not match:
        raise ValueError(f"Non trovo nessun utente esistente con username '{username}'.")

    old_line = match.group(0)
    indent = re.match(r"[ \t]*", old_line).group(0)
    trailing_comma = "," if old_line.rstrip().endswith(",") else ""
    new_line = indent + code_line.strip().rstrip(",") + trailing_comma + "\n"

    new_text = text[: match.start()] + new_line + text[match.end():]
    return new_text, username


def remove_user(text, username):
    """Elimina la riga dell'utente con questo username, in qualunque struttura si trovi.
    Se era l'ultimo elemento dell'array, toglie anche la virgola in eccesso rimasta sulla
    riga precedente, per non lasciare una virgola finale prima della chiusura ']'."""
    line_pattern = re.compile(
        r"[ \t]*\{[^\n]*username:\s*'" + re.escape(username) + r"'[^\n]*\},?[ \t]*\n"
    )
    match = line_pattern.search(text)
    if not match:
        raise ValueError(f"Non trovo nessun utente esistente con username '{username}'.")

    removed_line = match.group(0)
    was_last_item = not removed_line.rstrip().endswith(",")

    before = text[: match.start()]
    after = text[match.end():]

    if was_last_item:
        # La riga subito sopra (se finisce con virgola) diventa il nuovo ultimo elemento:
        # le togliamo la virgola per restare coerenti con lo stile delle altre liste. Il
        # controllo è ancorato alla FINE di "before" (non una ricerca su tutto il file:
        # altrimenti rischierebbe di modificare un'altra lista simile altrove nel codice).
        prev_line_pattern = re.compile(r"([ \t]*\{[^\n]*\}),([ \t]*\n)\Z")
        m2 = prev_line_pattern.search(before)
        if m2:
            before = before[: m2.start()] + m2.group(1) + m2.group(2)

    new_text = before + after
    return new_text, username


def run(cmd, **kwargs):
    print("$", " ".join(cmd))
    subprocess.run(cmd, cwd=ROOT, check=True, **kwargs)


def main():
    print("=== Gestione utenti Olovisita ===")
    print("1) Aggiungi un nuovo utente")
    print("2) Resetta la password di un utente esistente")
    print("3) Elimina un utente esistente")
    choice = input("Scegli (1/2/3): ").strip()
    if choice not in ("1", "2", "3"):
        sys.exit("Scelta non valida.")

    text = SRC.read_text(encoding="utf-8")

    if choice in ("1", "2"):
        print("\nIncolla qui sotto la riga di codice generata dal pannello admin (quella che inizia")
        print("con '{ username: ...'), poi premi invio:")
        code_line = input("> ").strip()
        if not code_line.startswith("{") or "username:" not in code_line:
            sys.exit("Il codice incollato non sembra valido (deve iniziare con '{' e contenere 'username:').")

    if choice == "1":
        print("\nA quale struttura appartiene?")
        print("  struttura1 = Centro Tunisia")
        print("  struttura2 = Ospedale Vincenzo Cervello")
        facility = input("(struttura1/struttura2): ").strip()
        if facility not in FACILITY_LABELS:
            sys.exit("Struttura non valida: scrivi esattamente 'struttura1' o 'struttura2'.")
        try:
            new_text, username = add_new_user(text, facility, code_line)
        except ValueError as e:
            sys.exit(str(e))
        action_desc = f"Aggiungo l'utente {username} a {FACILITY_LABELS[facility]}"
    elif choice == "2":
        try:
            new_text, username = reset_password(text, code_line)
        except ValueError as e:
            sys.exit(str(e))
        action_desc = f"Resetto la password dell'utente {username}"
    else:
        username = input("\nUsername dell'utente da eliminare: ").strip()
        if not username:
            sys.exit("Username vuoto.")
        try:
            new_text, username = remove_user(text, username)
        except ValueError as e:
            sys.exit(str(e))
        print(f"\nATTENZIONE: stai per eliminare definitivamente l'utente '{username}'.")
        print("Non potrà più accedere finché non lo ricrei da capo (con una password nuova).")
        action_desc = f"Elimino l'utente {username}"

    print(f"\n{action_desc}.")
    confirm = input("Confermi e applico la modifica al sorgente? (s/n): ").strip().lower()
    if confirm != "s":
        sys.exit("Operazione annullata, nessuna modifica fatta.")

    SRC.write_text(new_text, encoding="utf-8")
    print(f"Modifica applicata a {SRC.name}.")

    print("\nRicostruisco la build minificata...")
    run([sys.executable, "build_minified.py"])

    print("\nModifiche pronte. Vuoi pubblicarle subito (commit + push)?")
    confirm_push = input("(s/n): ").strip().lower()
    if confirm_push != "s":
        print("Fatto qui: le modifiche sono nei file ma non sono state pubblicate.")
        print("Per pubblicarle più avanti: git add -A && git commit -m \"...\" && git push")
        return

    run(["git", "add", "televisita_fix.html", "docs/index.html"])
    run(["git", "commit", "-m", action_desc])
    run(["git", "push"])
    print(f"\nFatto: {action_desc}. Il sito si aggiornerà su GitHub Pages tra qualche minuto.")


if __name__ == "__main__":
    main()
