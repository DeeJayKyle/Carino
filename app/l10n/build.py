"""Builds assets/i18n/<code>.json for the app's languages.

keys.json lists the English text used in the app (tr('…') and Tx('…') in lib/), in a fixed order.
Each <code>.txt has one translation per line as "index|translation" ({0}, {1} … are filled in by the
app; \\n is a line break). Missing lines fall back to English. Run: python3 l10n/build.py
"""
import json, re, sys, pathlib
P = pathlib.Path(__file__).parent
keys = json.load(open(P / 'keys.json'))
out_dir = P.parent / 'assets' / 'i18n'
ok = True
for f in sorted(P.glob('*.txt')):  # one per language
    code = f.stem
    words = {}
    for n, line in enumerate(f.read_text().splitlines(), 1):
        if not line.strip(): continue
        idx, _, text = line.partition('|')
        i = int(idx)
        k = keys[i]
        text = text.replace('\\n', '\n')
        ph_k = set(re.findall(r'\{\d+\}', k)); ph_t = set(re.findall(r'\{\d+\}', text))
        if ph_t - ph_k: print(f'{code}:{n} [{i}] unknown placeholder {ph_t - ph_k}: {k!r} -> {text!r}'); ok = False
        if '{0}' in ph_k and '{0}' not in ph_t: print(f'{code}:{n} [{i}] missing {{0}}: {k!r} -> {text!r}'); ok = False
        if i in words: print(f'{code}: duplicate {i}'); ok = False
        words[k] = text
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f'{code}.json').write_text(json.dumps(words, ensure_ascii=False, indent=0, sort_keys=True))
    print(code, len(words), 'of', len(keys))
sys.exit(0 if ok else 1)
