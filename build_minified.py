#!/usr/bin/env python3
"""Genera dist/televisita_fix.html minificando il JS dentro <script>...</script>.
Il file alla radice (televisita_fix.html) resta leggibile per il lavoro di sviluppo;
solo dist/televisita_fix.html va pubblicato (è quello che GitHub Pages serve)."""
import re
import subprocess
import sys
from pathlib import Path

SRC = Path(__file__).parent / "televisita_fix.html"
DIST = Path(__file__).parent / "dist" / "televisita_fix.html"

html = SRC.read_text(encoding="utf-8")

scripts = list(re.finditer(r"<script>(.*?)</script>", html, re.S))
if len(scripts) != 1:
    sys.exit(f"Attesi esattamente 1 blocco <script>...</script>, trovati {len(scripts)}. Controlla manualmente.")

original_js = scripts[0].group(1)

result = subprocess.run(
    ["npx", "-y", "terser", "--compress", "--mangle"],
    input=original_js, capture_output=True, text=True
)
if result.returncode != 0:
    sys.exit(f"Errore terser:\n{result.stderr}")

minified_js = result.stdout.strip()

new_html = html[:scripts[0].start(1)] + minified_js + html[scripts[0].end(1):]

DIST.parent.mkdir(exist_ok=True)
DIST.write_text(new_html, encoding="utf-8")
print(f"OK: {SRC.name} ({len(original_js)} byte di JS) -> {DIST} ({len(minified_js)} byte di JS minificato)")
