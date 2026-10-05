#!/usr/bin/env python3
"""Install/remove an explicitly requested per-user service. Never runs as root."""
import argparse, os, pathlib, plistlib, shutil, subprocess, sys
p=argparse.ArgumentParser();p.add_argument('action',choices=['install','remove']);p.add_argument('--cpus',type=int,default=4);p.add_argument('--memory-mb',type=int,default=8192);p.add_argument('--max-jobs',type=int,default=2);a=p.parse_args()
if os.geteuid()==0:sys.exit('Run as your ordinary user, not root.')
binary=shutil.which('cloud-agents')
if a.action=='install' and not binary:sys.exit('Install cloud-agents and add it to PATH first.')
if min(a.cpus,a.memory_mb,a.max_jobs)<1:sys.exit('Resource limits must be positive.')
args=[binary or '', '--cpus',str(a.cpus),'--memory-mb',str(a.memory_mb),'--max-jobs',str(a.max_jobs),'serve']
home=pathlib.Path.home(); service='dev.cloudagents.host'
if sys.platform=='darwin':
    path=home/'Library/LaunchAgents'/f'{service}.plist'
    subprocess.run(['launchctl','bootout',f'gui/{os.getuid()}/{service}'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if a.action=='remove':path.unlink(missing_ok=True)
    else:
        path.parent.mkdir(parents=True,exist_ok=True)
        logs=home/'Library/Logs/CloudAgents';logs.mkdir(parents=True,exist_ok=True)
        with path.open('wb') as f:plistlib.dump(dict(Label=service,ProgramArguments=args,RunAtLoad=True,KeepAlive=True,ThrottleInterval=10,EnvironmentVariables=dict(PATH=os.environ['PATH'],HOME=str(home)),StandardOutPath=str(logs/'host.log'),StandardErrorPath=str(logs/'host-error.log')),f)
        subprocess.run(['launchctl','bootstrap',f'gui/{os.getuid()}',str(path)],check=True)
else:
    path=home/'.config/systemd/user/cloud-agents.service'
    if a.action=='remove':
        subprocess.run(['systemctl','--user','disable','--now','cloud-agents.service'],check=False);path.unlink(missing_ok=True)
    else:
        path.parent.mkdir(parents=True,exist_ok=True)
        # systemd uses its own quoting; reject control characters and escape % specifiers.
        def quote(s):
            if '\n' in s or '\r' in s:raise ValueError('Invalid service argument')
            return '"'+s.replace('\\','\\\\').replace('"','\\"').replace('%','%%')+'"'
        path.write_text('[Unit]\nDescription=Cloud Agents personal host\nAfter=network-online.target\n\n[Service]\nExecStart='+ ' '.join(map(quote,args))+'\nEnvironment='+quote('PATH='+os.environ['PATH'])+'\nRestart=on-failure\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n')
    subprocess.run(['systemctl','--user','daemon-reload'],check=True)
    if a.action=='install':subprocess.run(['systemctl','--user','enable','--now','cloud-agents.service'],check=True)
print('Service '+('installed. Containers survive service restarts.' if a.action=='install' else 'removed. Existing containers were not deleted.'))
