#!/usr/bin/env bash
# Writes the notes for a Carino release to notes.md: how to install, then docs/release-notes/v<version>.md.
# Usage: release-notes.sh <version> <commit>
set -euo pipefail
V="$1"; SHA="$2"
printf '## Carino %s\n\n**Android:** download `Carino-%s.apk` on your phone and open it (allow *Install unknown apps* when asked).\n**Windows:** download and run `Carino-Setup-%s.exe` (no administrator rights needed).\n\nCarino runs on your own devices. On first start, pick one of the free AI services (Gemini, Groq, OpenRouter and more), paste its key, then tap *Test speed* to pick the fastest model. Already have Carino? Install this over it; your data and sign-ins carry over.\n\nBuilt from commit %s.\n\n' "$V" "$V" "$V" "$SHA" > notes.md
if [ -f "docs/release-notes/v$V.md" ]; then cat "docs/release-notes/v$V.md" >> notes.md; fi
