"""Refresh the pinned vendor snapshot from a local MyTerminal checkout; never edits it."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

source = Path(sys.argv[1])
destination = Path('vendor/myterminal')
revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
files = ['package.json', 'src/index.css', 'electron/local-terminal.js', 'electron/security-utils.js', 'electron/main.js', 'electron/ssh-manager.js', 'electron/tunnel-manager.js']
files += ['electron/ipc/' + name + '.js' for name in ['sessions', 'logging', 'tunnels', 'backup']]
files += ['src/components/' + name + '.jsx' for name in ['TerminalTab', 'SftpPanel', 'AiBar', 'SnippetPanel', 'SplitTerminalPane', 'TunnelPanel', 'FileEditor', 'SettingsDialog', 'SessionDialog']]
files += [str(p.relative_to(source)).replace('\\', '/') for folder in ['src/utils', 'src/store', 'tests'] for p in (source / folder).glob('*') if p.is_file()]
manifest = {'repository': 'https://github.com/xuemin-liu/MyTerminal', 'revision': revision, 'files': {}}
for name in files:
    data = subprocess.check_output(['git', '-C', str(source), 'show', f'{revision}:{name}']).replace(b'\r\n', b'\n')
    target = destination / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    manifest['files'][name] = hashlib.sha256(data).hexdigest()
(destination / 'upstream.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
subprocess.run(['git', 'apply', '--directory=vendor/myterminal', str(destination / 'desktop.patch')], check=True)
