#!/bin/sh
# macOS: double-click this file in Finder. Ctrl-C stops Fractal.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
  .venv/bin/python -m pip install .
fi
exec .venv/bin/python -m fractal "$@"
