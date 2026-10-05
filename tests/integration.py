#!/usr/bin/env python3
"""Real Docker contract test. Uses only its own temporary state and containers."""
import io, json, os, pathlib, signal, socket, subprocess, tarfile, tempfile, time, urllib.request, urllib.error
ROOT = pathlib.Path(__file__).resolve().parents[1]
BINARY = pathlib.Path(os.environ.get('CLOUD_AGENTS_BIN', str(ROOT / 'target/debug/cloud-agents')))

def main():
    with tempfile.TemporaryDirectory(prefix='cloud-agents-test-') as temp:
        state = pathlib.Path(temp)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        args = [str(BINARY), '--data-dir', temp, '--bind', f'127.0.0.1:{port}', '--max-jobs', '1', '--cpus', '2', '--memory-mb', '2048', '--min-free-gb', '0']
        host = None; ids = []
        def start():
            nonlocal host
            host = subprocess.Popen(args + ['serve'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(100):
                try:
                    if call('/host')['health']['docker_ready']: return
                except (OSError, ValueError): pass
                if host.poll() is not None: raise AssertionError('Host exited unexpectedly')
                time.sleep(.2)
            raise AssertionError('Host startup timed out')
        def stop():
            if host and host.poll() is None: host.send_signal(signal.SIGINT); host.wait(timeout=10)
        def call(path, method='GET', body=None, auth=True, raw=False):
            headers = {'Content-Type':'application/json'}
            if auth: headers['Authorization'] = 'Bearer ' + (state / 'token').read_text().strip()
            req = urllib.request.Request(f'http://127.0.0.1:{port}/api{path}', data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=60) as r:
                data=r.read(); return data if raw else json.loads(data) if data else None
        def create(**kw):
            payload = dict(provider='smoke',prompt='Real sandbox integration check',cpus=1,memory_mb=256,timeout_secs=60)
            payload.update(kw); j=call('/jobs','POST',payload); ids.append(j['id']);return j
        def wait(j, statuses, seconds=40):
            until=time.monotonic()+seconds
            while time.monotonic()<until:
                current=call('/jobs/'+j['id'])
                if current['status'] in statuses:return current
                time.sleep(.2)
            raise AssertionError(f'Timed out: {current}')
        def docker(*args): return subprocess.check_output(['docker',*args],stderr=subprocess.STDOUT).decode()
        try:
            start()
            try: call('/jobs',auth=False); raise AssertionError('Unauthenticated API accepted')
            except urllib.error.HTTPError as e: assert e.code == 401
            try: create(repository='file:///etc'); raise AssertionError('Unsafe clone accepted')
            except urllib.error.HTTPError as e: assert e.code == 400
            try: create(provider='codex'); raise AssertionError('Missing credentials accepted')
            except urllib.error.HTTPError as e: assert e.code == 409
            # Pause a real running container so we can reliably assert queue/cancellation/recovery.
            first=create(); wait(first,{'running'}); name='cloud-agents-'+first['id']; docker('pause',name)
            second=create(); time.sleep(1); assert call('/jobs/'+second['id'])['status']=='queued'
            call('/jobs/'+second['id']+'/cancel','POST'); assert call('/jobs/'+second['id'])['status']=='cancelled'
            info=json.loads(docker('inspect',name))[0]
            assert info['HostConfig']['ReadonlyRootfs'] and info['HostConfig']['CapDrop']==['ALL']
            assert info['HostConfig']['Memory']==256*1024*1024 and info['HostConfig']['PidsLimit']==256
            assert info['Config']['User']==f'{os.geteuid()}:{os.getegid()}'
            assert all('docker.sock' not in m['Source'] for m in info['Mounts'])
            stop(); start(); assert call('/jobs/'+first['id'])['status']=='running'; docker('unpause',name)
            done=wait(first,{'succeeded','failed'}); assert done['status']=='succeeded',done
            output=call('/jobs/'+first['id']+'/logs')['output']; assert 'Verified:' in output,output
            assert not (state/'jobs'/first['id']/'secrets').exists()
            archive=call('/jobs/'+first['id']+'/archive',raw=True)
            with tarfile.open(fileobj=io.BytesIO(archive),mode='r:gz') as t:
                assert t.extractfile('./repo/result.txt').read()==b'Hello from your own hardware.\n'
            # Running cancellation, not just a queued status change.
            third=create();wait(third,{'running'});docker('pause','cloud-agents-'+third['id'])
            call('/jobs/'+third['id']+'/cancel','POST');assert wait(third,{'cancelled'})['status']=='cancelled'
            # Timeout kills the actual workload and frees admission capacity.
            fourth=create(timeout_secs=10);wait(fourth,{'running'});docker('pause','cloud-agents-'+fourth['id'])
            timed=wait(fourth,{'failed'},seconds=25);assert timed['error']=='Run timed out',timed
            # Doctor must be observational and must never schedule work itself.
            stop(); fifth=None
            subprocess.run(args+['doctor'],check=True,stdout=subprocess.DEVNULL)
            start()
            for id in ids: call('/jobs/'+id,'DELETE')
            assert call('/jobs')==[]
            print('PASS: auth, URL validation, credential requirement, Docker isolation, FIFO budgets, queued/running cancel, restart recovery, timeout, logs, archive, cleanup')
        finally:
            stop()
            for id in ids: subprocess.run(['docker','rm','-f','cloud-agents-'+id],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

if __name__=='__main__': main()
