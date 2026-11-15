"""Record downstream adaptations against the pinned upstream revision."""
import difflib
import json
from pathlib import Path
import subprocess
import sys

root = Path('vendor/myterminal')
manifest = json.loads((root / 'upstream.json').read_text(encoding='utf-8'))
patch = []
for name in manifest['files']:
    original = subprocess.check_output(['git', '-C', sys.argv[1], 'show', f"{manifest['revision']}:{name}"]).decode('utf-8').replace('\r\n', '\n')
    current = (root / name).read_text(encoding='utf-8').replace('\r\n', '\n')
    patch.extend(difflib.unified_diff(original.splitlines(keepends=True), current.splitlines(keepends=True), fromfile='a/' + name, tofile='b/' + name))
(root / 'desktop.patch').write_text(''.join(patch), encoding='utf-8', newline='\n')
