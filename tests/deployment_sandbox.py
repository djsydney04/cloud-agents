#!/usr/bin/env python3
"""Exercise sandbox credential setup without Docker or cloud credentials."""
import json
import os
import pathlib
import shutil
import socket
import subprocess
import tempfile
import time


SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'sandbox' / 'entrypoint.sh'
PROXIES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
           'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']
ENVIRONMENT = PROXIES + ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE', 'GOOGLE_APPLICATION_CREDENTIALS',
    'KUBECONFIG', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'LD_PRELOAD',
    'NSS_WRAPPER_PASSWD', 'NSS_WRAPPER_GROUP']
PROBE = '''#!/usr/bin/env python3
import json, os, pathlib, stat
home = pathlib.Path(os.environ['HOME'])
files = {}
for relative in ['.kube/config', '.ssh/id_cloud_agents', '.ssh/known_hosts', '.ssh/config', '.passwd', '.group']:
    path = home / relative
    if path.exists():
        files[relative] = {'content': path.read_text(), 'mode': stat.S_IMODE(path.stat().st_mode)}
print(json.dumps({'environment': {key: os.environ[key] for key in KEYS if key in os.environ},
                  'files': files, 'input': __import__('sys').stdin.read()}))
'''.replace('KEYS', repr(ENVIRONMENT))


with tempfile.TemporaryDirectory(prefix='cloud-agents-deployment-') as directory:
    root = pathlib.Path(directory)
    commands = root / 'commands'
    commands.mkdir()
    for name, content in [('git', '#!/bin/sh\nexit 0\n'), ('codex', PROBE), ('claude', PROBE)]:
        path = commands / name
        path.write_text(content)
        path.chmod(0o700)

    def run(credentials, provider='codex', nss=False):
        case = root / str(len(list(root.iterdir())))
        case.mkdir()
        for name in ['home', 'secrets', 'input', 'workspace', 'opt']:
            (case / name).mkdir()
        (case / 'input' / 'prompt').write_text('Fixture prompt\n')
        for name, content in credentials.items():
            (case / 'secrets' / name).write_text(content)
        if nss:
            # The host may not have this Linux library; verify generated NSS inputs.
            (case / 'opt' / 'libnss_wrapper.so').touch()
        script = SOURCE.read_text()
        for original, replacement in [('/run/secrets', case / 'secrets'),
            ('/run/input', case / 'input'), ('/workspace', case / 'workspace'),
            ('/opt/cloud-agents', case / 'opt')]:
            script = script.replace(original, str(replacement))
        entrypoint = case / 'entrypoint.sh'
        entrypoint.write_text(script)
        env = {'PATH': str(commands) + os.pathsep + os.environ['PATH'],
               'HOME': str(case / 'home'), 'CODEX_HOME': str(case / 'home' / '.codex')}
        result = subprocess.run(['/bin/sh', str(entrypoint), provider], env=env,
                                text=True, capture_output=True)
        return case, result

    case, result = run({})
    assert result.returncode == 0, result.stderr
    baseline = json.loads(result.stdout)
    assert baseline['environment'] == {} and baseline['files'] == {}, baseline
    assert baseline['input'] == 'Fixture prompt\n'

    marker = root / 'must not execute'
    proxy = 'socks5h://proxy:1055/$(touch "' + str(marker) + '")`id`'
    credentials = {
        'cloudflare-api-token': 'fixture-cloudflare-token',
        'cloudflare-account-id': 'fixture-account',
        'google-credentials.json': '{"type":"external_account","audience":"fixture"}',
        'kubeconfig': 'apiVersion: v1\nclusters: []\n',
        'ssh-key': 'fixture-private-key\n',
        'ssh-known-hosts': 'fixture.invalid ssh-ed25519 fixture-key\n',
        'deployment-env.json': json.dumps({'ALL_PROXY': proxy, 'no_proxy': '', 'HTTPS_PROXY': 'http://proxy:8080'}),
        'openai-key': 'fixture-openai-key',
        'anthropic-key': 'fixture-anthropic-key',
    }
    for provider, provider_key in [('codex', 'CODEX_API_KEY'), ('claude', 'ANTHROPIC_API_KEY')]:
        case, result = run(credentials, provider, nss=True)
        assert result.returncode == 0, result.stderr
        state = json.loads(result.stdout)
        env, files = state['environment'], state['files']
        assert env['CLOUDFLARE_API_TOKEN'] == credentials['cloudflare-api-token']
        assert env['CLOUDFLARE_ACCOUNT_ID'] == credentials['cloudflare-account-id']
        assert env['CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE'] == str(case / 'secrets' / 'google-credentials.json')
        assert env['GOOGLE_APPLICATION_CREDENTIALS'] == env['CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE']
        assert env['KUBECONFIG'] == str(case / 'home' / '.kube' / 'config')
        assert env['ALL_PROXY'] == proxy and env['no_proxy'] == ''
        assert env['HTTPS_PROXY'] == 'http://proxy:8080'
        assert env[provider_key] == credentials['openai-key' if provider == 'codex' else 'anthropic-key']
        assert not marker.exists(), 'Proxy values must remain literal data'
        assert files['.kube/config']['content'] == credentials['kubeconfig']
        assert files['.ssh/id_cloud_agents']['content'] == credentials['ssh-key']
        assert files['.ssh/known_hosts']['content'] == credentials['ssh-known-hosts']
        assert all(item['mode'] == 0o600 for item in files.values()), files
        assert (case / 'home' / '.ssh').stat().st_mode & 0o777 == 0o700
        assert files['.passwd']['content'] == f'agent:x:{os.geteuid()}:{os.getegid()}:Cloud Agents:{case}/home:/bin/sh\n'
        assert files['.group']['content'] == f'agent:x:{os.getegid()}:\n'
        assert env['NSS_WRAPPER_PASSWD'] == str(case / 'home' / '.passwd')
        assert env['NSS_WRAPPER_GROUP'] == str(case / 'home' / '.group')
        assert env['LD_PRELOAD'] == str(case / 'opt' / 'libnss_wrapper.so')

    for invalid in ['[]', '{', '{"PATH":"/tmp"}', '{"HTTP_PROXY":1}',
                    '{"HTTP_PROXY":"bad\\u0000value"}', '{"HTTP_PROXY":"bad\\nvalue"}']:
        _, result = run({'deployment-env.json': invalid})
        assert result.returncode == 2 and 'Invalid deployment proxy configuration' in result.stderr, result
        assert result.stdout == '', 'Invalid proxy configuration must stop before the agent starts'

    case, result = run({'ssh-key': 'fixture-key'})
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)['files']['.ssh/known_hosts']['content'] == ''
    ssh = shutil.which('ssh')
    if ssh:
        config = case / 'home' / '.ssh' / 'config'
        effective = subprocess.run([ssh, '-G', '-F', str(config), 'fixture.invalid'],
                                   capture_output=True, text=True, check=True).stdout
        for option in ['stricthostkeychecking true', 'batchmode yes', 'identitiesonly yes',
                       'passwordauthentication no', 'kbdinteractiveauthentication no']:
            assert option in effective, effective
        assert 'globalknownhostsfile /dev/null' in effective
        assert str(case / 'home' / '.ssh' / 'known_hosts') in effective

        sshd, keygen = shutil.which('sshd'), shutil.which('ssh-keygen')
        if sshd and keygen:
            host_key = root / 'host-key'
            subprocess.run([keygen, '-q', '-t', 'ed25519', '-N', '', '-f', str(host_key)], check=True)
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                port = listener.getsockname()[1]
            server_config = root / 'sshd_config'
            server_config.write_text(f'HostKey "{host_key}"\nPort {port}\nListenAddress 127.0.0.1\n'
                f'PidFile "{root}/sshd.pid"\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n'
                'PubkeyAuthentication no\nAuthorizedKeysFile none\nUsePAM no\n')
            server = subprocess.Popen([sshd, '-D', '-e', '-f', str(server_config)],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            try:
                for _ in range(40):
                    if server.poll() is not None:
                        break
                    try:
                        with socket.create_connection(('127.0.0.1', port), timeout=0.1):
                            break
                    except OSError:
                        time.sleep(0.05)
                if server.poll() is None:
                    unknown = subprocess.run([ssh, '-F', str(config), '-o', 'ConnectTimeout=3',
                        '-p', str(port), '127.0.0.1', 'true'], capture_output=True, text=True, timeout=5)
                    assert unknown.returncode == 255 and 'Host key verification failed' in unknown.stderr, unknown.stderr
                else:
                    print('SKIP: local sshd unavailable:', server.stderr.read().strip())
            finally:
                if server.poll() is None:
                    server.terminate()
                server.communicate(timeout=5)

print('PASS: deployment credential setup, private file permissions, literal proxies and strict SSH')
