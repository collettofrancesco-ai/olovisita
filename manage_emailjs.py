#!/usr/bin/env python3
"""Gestisce le catene di account EmailJS per struttura (DEFAULT_EMAILJS_CONFIGS) usate per
inviare le email reali ai pazienti dall'indirizzo corretto di ciascuna struttura.

Ogni struttura ha la propria catena indipendente (principale + fallback): se l'account
principale esaurisce la quota mensile, l'app passa automaticamente al successivo.

Uso: python3 manage_emailjs.py
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent
SRC = ROOT / "televisita_fix.html"

FACILITIES = {"struttura1": "Centro Tunisia", "struttura2": "Ospedale Vincenzo Cervello"}


def find_facility_block(text, facility):
    """Trova il sotto-blocco della struttura dentro DEFAULT_EMAILJS_CONFIGS."""
    outer = re.search(r"const\s+DEFAULT_EMAILJS_CONFIGS\s*=\s*\{", text)
    if not outer:
        raise ValueError("Non trovo DEFAULT_EMAILJS_CONFIGS nel sorgente.")

    # Conta le graffe per isolare l'intero blocco esterno
    depth = 0
    outer_start = text.index('{', outer.start())
    outer_end = outer_start
    for i in range(outer_start, len(text)):
        if text[i] == '{': depth += 1
        elif text[i] == '}':
            depth -= 1
            if depth == 0:
                outer_end = i + 1
                break

    outer_block = text[outer_start:outer_end]

    # Dentro il blocco esterno, trova strutturaN: [...]
    inner_m = re.search(r'\b' + re.escape(facility) + r'\s*:\s*\[', outer_block)
    if not inner_m:
        raise ValueError(f"Non trovo {facility} in DEFAULT_EMAILJS_CONFIGS.")

    bracket_pos = outer_block.index('[', inner_m.start())
    depth = 0
    bracket_end = bracket_pos
    for i in range(bracket_pos, len(outer_block)):
        if outer_block[i] == '[': depth += 1
        elif outer_block[i] == ']':
            depth -= 1
            if depth == 0:
                bracket_end = i + 1
                break

    abs_bracket_start = outer_start + bracket_pos
    abs_bracket_end = outer_start + bracket_end
    return abs_bracket_start, abs_bracket_end


def get_items(text, facility):
    start, end = find_facility_block(text, facility)
    block = text[start:end]
    return re.findall(r"\{[^\n]*\}", block)


def rebuild_facility_block(text, facility, new_items):
    start, end = find_facility_block(text, facility)
    inner = text[start:end]

    # Calcola l'indentazione degli item esistenti
    m = re.search(r'\[\s*\n(\s*)\{', inner)
    item_indent = m.group(1) if m else '                '

    new_content = (
        '[\n'
        + (',\n').join(item_indent + it.rstrip(',') for it in new_items)
        + '\n' + item_indent[:-4] + ']'
    )
    return text[:start] + new_content + text[end:]


def add_config(text, facility, config_line):
    items = get_items(text, facility)
    items.append(config_line.strip().rstrip(","))
    return rebuild_facility_block(text, facility, items)


def replace_config(text, facility, index, config_line):
    items = get_items(text, facility)
    if index < 0 or index >= len(items):
        raise ValueError(f"Indice non valido: ci sono {len(items)} account (0-{len(items)-1}).")
    items[index] = config_line.strip().rstrip(",")
    return rebuild_facility_block(text, facility, items)


def remove_config(text, facility, index):
    items = get_items(text, facility)
    if index < 0 or index >= len(items):
        raise ValueError(f"Indice non valido: ci sono {len(items)} account (0-{len(items)-1}).")
    if len(items) == 1:
        raise ValueError("Non posso eliminare l'unico account: la struttura smetterebbe di inviare email.")
    del items[index]
    return rebuild_facility_block(text, facility, items)


def build_config_line(public_key, service_id, template_id):
    esc = lambda s: s.replace("'", "\\'")
    return f"{{ publicKey: '{esc(public_key)}', serviceId: '{esc(service_id)}', templateId: '{esc(template_id)}' }}"


def run(cmd, **kwargs):
    print("$", " ".join(cmd))
    subprocess.run(cmd, cwd=ROOT, check=True, **kwargs)


def choose_facility():
    print("\nPer quale struttura?")
    for k, v in FACILITIES.items():
        print(f"  {k} = {v}")
    facility = input("(struttura1/struttura2): ").strip()
    if facility not in FACILITIES:
        sys.exit("Struttura non valida.")
    return facility


def main():
    print("=== Gestione account EmailJS per struttura ===")
    text = SRC.read_text(encoding="utf-8")

    print()
    for fac, label in FACILITIES.items():
        items = get_items(text, fac)
        print(f"  [{label}] — {len(items)} account nella catena:")
        for i, c in enumerate(items):
            print(f"    [{i}] {c}")
    print()

    print("1) Aggiungi un nuovo account in fondo alla catena di una struttura")
    print("2) Sostituisci un account esistente")
    print("3) Elimina un account esistente")
    choice = input("\nScegli (1/2/3): ").strip()
    if choice not in ("1", "2", "3"):
        sys.exit("Scelta non valida.")

    facility = choose_facility()
    items = get_items(text, facility)

    if choice in ("1", "2"):
        print("\nInserisci i dati dell'account EmailJS (li trovi sulla dashboard di EmailJS):")
        public_key  = input("Public Key:   ").strip()
        service_id  = input("Service ID:   ").strip()
        template_id = input("Template ID:  ").strip()
        if not (public_key and service_id and template_id):
            sys.exit("Tutti i campi sono obbligatori.")
        config_line = build_config_line(public_key, service_id, template_id)

    try:
        label = FACILITIES[facility]
        if choice == "1":
            new_text = add_config(text, facility, config_line)
            action_desc = f"Aggiungo un account EmailJS alla catena di {label}"
        elif choice == "2":
            index = int(input(f"\nIndice da sostituire (0-{len(items)-1}): ").strip())
            new_text = replace_config(text, facility, index, config_line)
            action_desc = f"Sostituisco l'account EmailJS [{index}] di {label}"
        else:
            index = int(input(f"\nIndice da eliminare (0-{len(items)-1}): ").strip())
            new_text = remove_config(text, facility, index)
            print(f"\nATTENZIONE: stai per eliminare l'account [{index}] dalla catena di {label}.")
            action_desc = f"Elimino l'account EmailJS [{index}] di {label}"
    except ValueError as e:
        sys.exit(str(e))

    print(f"\n{action_desc}.")
    confirm = input("Confermi e applico la modifica al sorgente? (s/n): ").strip().lower()
    if confirm != "s":
        sys.exit("Operazione annullata, nessuna modifica fatta.")

    backup_path = SRC.with_suffix(SRC.suffix + ".bak")
    backup_path.write_text(text, encoding="utf-8")
    print(f"Copia di sicurezza salvata in {backup_path.name}.")

    SRC.write_text(new_text, encoding="utf-8")
    print(f"Modifica applicata a {SRC.name}.")

    print("\nRicostruisco la build minificata...")
    run([sys.executable, "build_minified.py"])

    print("\nModifiche pronte. Vuoi pubblicarle subito (commit + push)?")
    if input("(s/n): ").strip().lower() != "s":
        print("Fatto qui: le modifiche sono nei file ma non sono state pubblicate.")
        print("Per pubblicarle più avanti: git add -A && git commit -m \"...\" && git push")
        return

    run(["git", "add", "televisita_fix.html", "docs/index.html"])
    run(["git", "commit", "-m", action_desc])
    run(["git", "push"])
    print(f"\nFatto: {action_desc}. Il sito si aggiornerà su GitHub Pages tra qualche minuto.")


if __name__ == "__main__":
    main()
