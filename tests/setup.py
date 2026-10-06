#!/usr/bin/env python3
"""First-run provisioning contract with an isolated Docker executable fixture."""
import json, os, pathlib, subprocess, tempfile
with tempfile.TemporaryDirectory(prefix='cloud agents setup ') as root:
    root = pathlib.Path(root)
    commands = root / 'commands'; commands.mkdir()
    docker = commands / 'docker'
    docker.write_text('''#!/usr/bin/env python3
import json,os,pathlib,sys
root=pathlib.Path(os.environ['SETUP_FIXTURE'])
a=sys.argv[1:]
if a[0]=='info': print(json.dumps({'NCPU':2,'MemTotal':2147483648}))
elif a[:2]==['image','inspect']: sys.exit(0 if (root/'built').exists() else 1)
elif a[0]=='build':
 context=pathlib.Path(a[-1])
 for name in ['Dockerfile','entrypoint.sh','askpass.sh']:
  assert (context/name).read_bytes()==(pathlib.Path(os.environ['SETUP_SOURCE'])/name).read_bytes()
 assert not (root/'built').exists(), 'Existing image must not rebuild'
 (root/'built').write_text('yes')
else: raise AssertionError(a)
''')
    docker.chmod(0o700)
    state = root / 'host'
    env = dict(os.environ, PATH=str(commands)+os.pathsep+os.environ['PATH'], SETUP_FIXTURE=str(root), SETUP_SOURCE=str(pathlib.Path('sandbox').resolve()))
    command = ['target/debug/cloud-agents', '--data-dir', str(state), 'setup']
    subprocess.run(command, env=env, check=True)
    assert (root/'built').exists()
    file = state/'settings.json'; settings = json.loads(file.read_text())
    assert settings['cpus']==1 and settings['memory_mb']==1024 and settings['max_jobs']==1, settings
    assert file.stat().st_mode & 0o777 == 0o600
    settings['paused'] = True; settings['revision']=4; file.write_text(json.dumps(settings))
    subprocess.run(command, env=env, check=True)
    assert json.loads(file.read_text())==settings, 'Repeat setup must preserve user settings'
    print('PASS: embedded first-run build, adaptive limits, private storage and idempotent setup')
