#!/usr/bin/env python3
"""Crea una nuova cartella di deployment di Olovisita configurata per due strutture diverse.

Copia il sorgente attuale, sostituisce i nomi delle strutture, svuota la lista utenti
(da aggiungere poi con manage_users.py), poi ricostruisce docs/index.html.

Uso: python3 manage_deployment.py
"""
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent
SRC = ROOT / "televisita_fix.html"
BUILD_SCRIPT = ROOT / "build_minified.py"
MANAGE_USERS_SRC = ROOT / "manage_users.py"
VENDOR_SRC = ROOT / "vendor"


# ──────────────────────────────────────────────────────────────────────────────
# Utility
# ──────────────────────────────────────────────────────────────────────────────

def slugify(s: str) -> str:
    for src, dst in [
        ('à','a'),('á','a'),('â','a'),('ä','a'),('è','e'),('é','e'),
        ('ê','e'),('ë','e'),('ì','i'),('í','i'),('î','i'),('ï','i'),
        ('ò','o'),('ó','o'),('ô','o'),('ö','o'),('ù','u'),('ú','u'),
        ('û','u'),('ü','u'),('ñ','n'),('ç','c'),
    ]:
        s = s.replace(src, dst)
    s = re.sub(r'[^a-z0-9]+', '-', s.lower())
    return s.strip('-')[:20]


def make_avatar(name: str) -> str:
    """Calcola due iniziali per l'avatar ignorando articoli e preposizioni."""
    noise = r'\b(di|della|del|degli|delle|dei|il|la|lo|le|e|a|-)\b'
    clean = re.sub(noise, ' ', name, flags=re.I).strip()
    words = [w for w in clean.split() if len(w) > 1 and w != '-']
    if not words:
        words = name.split()
    return ''.join(w[0].upper() for w in words[:2]) or name[:2].upper()


def short_name(name: str) -> str:
    """Estrae la parola più distintiva dal nome completo per il titolo della cartella.
    Rimuove tipi istituzionali e particelle, prende l'ultima parola rimasta
    (di solito il nome del luogo o l'identificativo finale)."""
    institution = r'\b(ospedale|ospedaliera|centro|clinica|presidio|polo|azienda|asl|irccs|istituto|policlinico|struttura|unità|reparto|divisione|civico|civile|generale|universitario|universitaria|mroe)\b'
    specialty   = r'\b(ematologia|oncologia|cardiologia|pediatria|neurologia|chirurgia|medicina|geriatria|radiologia|urologia|ortopedia|ginecologia|dermatologia|pneumologia|reumatologia|nefrologia)\b'
    particles    = r'\b(di|della|del|degli|delle|dei|il|la|lo|le|e|a)\b'
    clean = re.sub(institution, ' ', name,  flags=re.I)
    clean = re.sub(specialty,   ' ', clean, flags=re.I)
    clean = re.sub(particles,   ' ', clean, flags=re.I)
    clean = re.sub(r'[-–()/]',  ' ', clean)
    words = [w for w in clean.split() if len(w) > 1]
    return words[-1].capitalize() if words else name.split()[0].capitalize()


def _find_js_block(text: str, pattern: str, start: int = 0) -> tuple:
    """Trova il blocco JS delimitato da {} che inizia dove fa match il pattern.
    Restituisce (start_brace, end_brace_exclusive)."""
    m = re.search(pattern, text[start:])
    if not m:
        raise ValueError(f"Blocco non trovato nel sorgente (pattern: {pattern[:60]})")
    abs_start = start + m.start()
    brace_pos = text.index('{', abs_start)
    depth = 0
    for i in range(brace_pos, len(text)):
        if text[i] == '{':
            depth += 1
        elif text[i] == '}':
            depth -= 1
            if depth == 0:
                return brace_pos, i + 1
    raise ValueError(f"Blocco JS non chiuso: {pattern[:60]}")


# ──────────────────────────────────────────────────────────────────────────────
# Sostituzioni in televisita_fix.html
# ──────────────────────────────────────────────────────────────────────────────

def replace_room_code(text: str, slug: str) -> str:
    new, n = re.subn(
        r"(const FIXED_ROOM_CODE\s*=\s*')[^']*(')",
        rf"\1Olovisita_{slug}\2",
        text, count=1
    )
    if n == 0:
        raise ValueError("Non trovo FIXED_ROOM_CODE nel sorgente.")
    return new


def replace_facility_block(text: str, sid: str, new_name: str) -> str:
    """Aggiorna name, fullName, avatar e svuota users per strutturaN in FACILITIES."""
    escaped = new_name.replace("'", "\\'")
    avatar = make_avatar(new_name)

    # Isola l'intero blocco const FACILITIES = { ... }
    fac_start, fac_end = _find_js_block(text, r'const FACILITIES\s*=\s*\{')
    fac_block = text[fac_start:fac_end]

    # Dentro FACILITIES, isola il sotto-blocco strutturaN: { ... }
    m = re.search(r'\b' + re.escape(sid) + r'\s*:\s*\{', fac_block)
    if not m:
        raise ValueError(f"Non trovo {sid} in FACILITIES.")
    inner_brace = fac_block.index('{', m.start())
    depth = 0
    inner_end = inner_brace
    for i in range(inner_brace, len(fac_block)):
        if fac_block[i] == '{':
            depth += 1
        elif fac_block[i] == '}':
            depth -= 1
            if depth == 0:
                inner_end = i + 1
                break

    sid_block = fac_block[inner_brace:inner_end]

    # Nel blocco strutturaN: sostituisce name, fullName, avatar, svuota users
    sid_block = re.sub(r"(name:\s*)'[^']*'",     rf"\1'{escaped}'", sid_block, count=1)
    sid_block = re.sub(r"(fullName:\s*)'[^']*'", rf"\1'{escaped}'", sid_block, count=1)
    sid_block = re.sub(r"(avatar:\s*)'[^']*'",   rf"\1'{avatar}'",  sid_block, count=1)
    sid_block = re.sub(r"(users:\s*\[).*?(\])",  r"\1\2",           sid_block, count=1, flags=re.S)

    new_fac = fac_block[:inner_brace] + sid_block + fac_block[inner_end:]
    return text[:fac_start] + new_fac + text[fac_end:]


def replace_doctors_facility(text: str, s1_name: str, s2_name: str) -> str:
    """Aggiorna il campo facility: in let DOCTORS per entrambe le strutture."""
    s1_esc = s1_name.replace("'", "\\'")
    s2_esc = s2_name.replace("'", "\\'")

    doc_start, doc_end = _find_js_block(text, r'let DOCTORS\s*=\s*\{')
    block = text[doc_start:doc_end]

    block = re.sub(
        r"(struttura1\s*:[^}]*?facility:\s*)'[^']*'",
        rf"\1'{s1_esc}'", block, count=1, flags=re.S
    )
    block = re.sub(
        r"(struttura2\s*:[^}]*?facility:\s*)'[^']*'",
        rf"\1'{s2_esc}'", block, count=1, flags=re.S
    )
    return text[:doc_start] + block + text[doc_end:]


def replace_translations(text: str, s1_name: str, s2_name: str) -> str:
    """Aggiorna facility_s1_name e facility_s2_name in tutti i blocchi traduzione (IT e FR)."""
    text = re.sub(r'(facility_s1_name:\s*")[^"]*(")', rf'\1{s1_name}\2', text)
    text = re.sub(r'(facility_s2_name:\s*")[^"]*(")', rf'\1{s2_name}\2', text)
    return text


def replace_admin_dropdown(text: str, s1_name: str, s2_name: str) -> str:
    """Aggiorna le <option> nel dropdown di selezione struttura nel pannello admin."""
    text = re.sub(r'(<option value="struttura1">)[^<]*(</option>)', rf'\1{s1_name}\2', text)
    text = re.sub(r'(<option value="struttura2">)[^<]*(</option>)', rf'\1{s2_name}\2', text)
    return text


def replace_login_html(text: str, s1_name: str, s2_name: str) -> str:
    """Aggiorna i testi nelle card di login (fallback pre-JS, poi sovrascritta dalle traduzioni)."""
    # Testo della card struttura 1 e 2 (può essere su più righe)
    text = re.sub(
        r'(data-i18n="facility_s1_name">)[^<]*(</div>)',
        rf'\1{s1_name}\2', text, flags=re.S
    )
    text = re.sub(
        r'(data-i18n="facility_s2_name">)[^<]*(</div>)',
        rf'\1{s2_name}\2', text, flags=re.S
    )
    # Badge struttura nel secondo step del login
    text = re.sub(
        r'(<span id="selected-facility-badge"[^>]*>)[^<]*(</span>)',
        rf'\1{s1_name}\2', text
    )
    return text


# ──────────────────────────────────────────────────────────────────────────────
# Aggiornamento manage_users.py
# ──────────────────────────────────────────────────────────────────────────────

def update_manage_users(src_text: str, s1_name: str, s2_name: str) -> str:
    new_labels = (
        'FACILITY_LABELS = {\n'
        f'    "struttura1": "{s1_name}",\n'
        f'    "struttura2": "{s2_name}",\n'
        '}'
    )
    new_text, n = re.subn(
        r'FACILITY_LABELS\s*=\s*\{[^}]*\}',
        new_labels,
        src_text, count=1, flags=re.S
    )
    if n == 0:
        raise ValueError("Non trovo FACILITY_LABELS in manage_users.py.")
    return new_text


# ──────────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────────

def run(cmd, cwd):
    print("  $", " ".join(str(c) for c in cmd))
    subprocess.run(cmd, cwd=cwd, check=True)


def main():
    print("=== Nuovo Deployment Olovisita ===")
    print()
    print("Crea una nuova cartella con il sorgente già configurato per due strutture.")
    print("Gli utenti si aggiungono poi nella nuova cartella con: python3 manage_users.py")
    print()

    s1_name = input("Nome Struttura 1: ").strip()
    if not s1_name:
        sys.exit("Nome vuoto.")

    s2_name = input("Nome Struttura 2: ").strip()
    if not s2_name:
        sys.exit("Nome vuoto.")

    default_slug = slugify(s1_name[:14]) + '_' + slugify(s2_name[:14])
    print(f"\nSlug del progetto (nel codice stanza MQTT) [{default_slug}]: ", end='')
    slug = input().strip() or default_slug

    desktop = Path.home() / "Desktop"
    folder_name = f"Olovisita {short_name(s1_name)}-{short_name(s2_name)}"
    default_dir = desktop / folder_name
    print(f"Cartella di output [{default_dir}]: ", end='')
    dir_input = input().strip()
    out_dir = Path(dir_input).expanduser().resolve() if dir_input else default_dir

    print(f"\n── Riepilogo ───────────────────────────────────────")
    print(f"  Struttura 1  : {s1_name}  (avatar: {make_avatar(s1_name)})")
    print(f"  Struttura 2  : {s2_name}  (avatar: {make_avatar(s2_name)})")
    print(f"  Codice stanza: Olovisita_{slug}")
    print(f"  Output       : {out_dir}")
    print(f"────────────────────────────────────────────────────")

    if out_dir.exists():
        print(f"\nATTENZIONE: la cartella esiste già.")
        if input("Sovrascrivi? (s/n): ").strip().lower() != 's':
            sys.exit("Annullato.")

    print()
    if input("Procedo? (s/n): ").strip().lower() != 's':
        sys.exit("Annullato.")

    # ── Parametrizza il sorgente ──────────────────────────────────────────────
    print("\nParametrizzo il sorgente...")
    text = SRC.read_text(encoding='utf-8')
    text = replace_room_code(text, slug)
    text = replace_facility_block(text, 'struttura1', s1_name)
    text = replace_facility_block(text, 'struttura2', s2_name)
    text = replace_doctors_facility(text, s1_name, s2_name)
    text = replace_translations(text, s1_name, s2_name)
    text = replace_admin_dropdown(text, s1_name, s2_name)
    text = replace_login_html(text, s1_name, s2_name)
    print("  OK")

    # ── Prepara la cartella di output ─────────────────────────────────────────
    print("Copio i file nella cartella di output...")
    out_dir.mkdir(parents=True, exist_ok=True)

    (out_dir / "televisita_fix.html").write_text(text, encoding='utf-8')

    shutil.copy(BUILD_SCRIPT, out_dir / BUILD_SCRIPT.name)

    mu_text = MANAGE_USERS_SRC.read_text(encoding='utf-8')
    mu_text = update_manage_users(mu_text, s1_name, s2_name)
    (out_dir / MANAGE_USERS_SRC.name).write_text(mu_text, encoding='utf-8')

    if VENDOR_SRC.is_dir():
        shutil.copytree(VENDOR_SRC, out_dir / "vendor", dirs_exist_ok=True)

    print("  OK")

    # ── Build ─────────────────────────────────────────────────────────────────
    print("Build docs/index.html...")
    run([sys.executable, str(out_dir / BUILD_SCRIPT.name)], cwd=out_dir)
    print("  OK")

    # ── Istruzioni ───────────────────────────────────────────────────────────
    print(f"""
╔══════════════════════════════════════════════════════════════╗
  Deployment creato in:
  {out_dir}

  Prossimi passi:

  1) Aggiungi i medici:
       cd "{out_dir}"
       python3 manage_users.py

  2) Pubblica su GitHub Pages:
       cd "{out_dir}"
       git init
       git add -A
       git commit -m "Primo deploy — {s1_name} / {s2_name}"
       git remote add origin <URL_NUOVO_REPO>
       git push -u origin main
       → Impostazioni repo › Pages › Branch: main › /docs
╚══════════════════════════════════════════════════════════════╝
""")


if __name__ == "__main__":
    main()
