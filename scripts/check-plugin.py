#!/usr/bin/env python3
"""Optional Quickshell smoke test; disposable HOME, stub installer, no network."""
from pathlib import Path
import tempfile,subprocess,os,time
repo=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='eventloom-qml-safe-') as temp:
 root=Path(temp); home=root/'home'; plugin=root/'plugin'; runtime=root/'runtime'
 home.mkdir();runtime.mkdir(mode=0o700);(plugin/'plugin').mkdir(parents=True);(home/'tools').mkdir()
 (plugin/'Service.qml').write_text((repo/'Service.qml').read_text().replace('interval: 60000','interval: 250'))
 (plugin/'plugin/setup.sh').write_bytes((repo/'plugin/setup.sh').read_bytes())
 def version(v): (plugin/'package.json').write_text('{\n  "version": "'+v+'"\n}\n')
 version('fixture-1')
 (plugin/'install.sh').write_text('#!/bin/sh\nprintf "attempt\\n" >> "$HOME/attempts"\n[ ! -f "$HOME/fail" ] || exit 1\nmkdir -p "$HOME/.local/bin" "$HOME/.local/lib/eventloom"\ncat > "$HOME/.local/bin/eventloom" <<\'CLI\'\n#!/bin/sh\n[ "$1:$2" = "agents:setup" ] || exit 99\nprintf "check\\n" >> "$HOME/agent-checks"\nif [ -f "$HOME/late-agent" ] && [ ! -f "$HOME/agent-connected" ]; then\n  touch "$HOME/agent-connected"\n  printf \'%s\\n\' \'{"ok":true,"changed":true,"agents":[{"agent":"codex","changed":true,"status":"registered"}]}\'\nfi\nCLI\nchmod +x "$HOME/.local/bin/eventloom"\n')
 (home/'tools/omarchy-notification-send').write_text('#!/bin/sh\nexit 0\n');(home/'tools/omarchy-notification-send').chmod(0o755)
 env={'HOME':str(home),'PATH':str(home/'tools')+':/usr/bin:/bin','QT_QPA_PLATFORM':'offscreen','XDG_RUNTIME_DIR':str(runtime),'XDG_CACHE_HOME':str(home/'cache')}
 log=open(root/'qml.log','w+'); proc=subprocess.Popen(['/usr/bin/qs','--no-color','-p',str(plugin/'Service.qml')],env=env,stdout=log,stderr=log)
 def attempts(): return len((home/'attempts').read_text().splitlines()) if (home/'attempts').exists() else 0
 def until(fn):
  deadline=time.monotonic()+9
  while time.monotonic()<deadline:
   if fn(): return
   if proc.poll() is not None: break
   time.sleep(.05)
  log.flush();log.seek(0);raise RuntimeError(log.read())
 try:
  until(lambda: attempts()==1 and (home/'.local/lib/eventloom/.installed-from').exists())
  until(lambda: (home/'agent-checks').exists())
  (home/'late-agent').touch();until(lambda: (home/'agent-connected').exists())
  time.sleep(.7);assert attempts()==1,'agent setup triggered package installation'
  (home/'fail').touch();version('fixture-2');until(lambda: attempts()==2)
  time.sleep(.8);assert attempts()==2,'failed revision retried automatically'
  (home/'fail').unlink();version('fixture-3');until(lambda: attempts()==3 and (home/'.local/lib/eventloom/.installed-from').read_text().strip()=='version fixture-3')
  print('QML runtime passed: automatic install, unchanged skip, one failed attempt, recovery on new revision, later-agent setup without reinstall; disposable HOME and stub installer.')
 finally:
  proc.terminate()
  try: proc.wait(timeout=3)
  except subprocess.TimeoutExpired: proc.kill();proc.wait()
  log.close()
