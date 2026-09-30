"""Established local defaults, explicit assigned targets, sanitized command logs."""
from pathlib import Path
import os, re, subprocess, sys, urllib.parse
root = Path(__file__).resolve().parents[2]
out = Path(__file__).resolve().parent
source = (root / 'apps/api/src/lib/test-target-lock.ts').read_text()
default = re.search(r"DATABASE_URL:\s*['\"]([^'\"]+)['\"]", source)
assert default, 'Local test harness default missing'
u = urllib.parse.urlsplit(default[1])
env = os.environ.copy()
env['PATH'] = '/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:' + env['PATH']
env['DATABASE_URL'] = urllib.parse.urlunsplit(u._replace(netloc=u.netloc.replace(u.hostname, '127.0.0.1'), path='/swift_test_hyg'))
env['REDIS_URL'] = 'redis://127.0.0.1:6382/9'
env['PRISMA_GENERATE_SKIP_AUTOINSTALL'] = '1'
env['NODE_OPTIONS'] = '--max-old-space-size=6144'
name, mode, *args = sys.argv[1:]
assert re.fullmatch(r'[a-zA-Z0-9_-]+', name)
heavy = '/Users/westbridgeinc/swift-coordination/scripts/heavy.sh'
if mode == 'test':
    cmd = [heavy, './node_modules/.bin/vitest', 'run', '--config', 'vitest.local-sos.config.ts', '--maxWorkers=1', *args]
    cwd = root / 'apps/api'
elif mode == 'types':
    cmd = [heavy, 'node', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.localcheck.json']
    cwd = root / 'apps/api'
elif mode == 'lint':
    cmd = [str(root / 'node_modules/.bin/eslint'), *args]
    cwd = root
elif mode == 'probe':
    env['PGPASSWORD'] = urllib.parse.unquote(u.password or '')
    cmd = ['psql', '-w', '-h', '127.0.0.1', '-p', '5434', '-U', u.username, '-d', 'swift_test_hyg', '-c', 'SELECT current_database(), system_identifier FROM pg_control_system();']
    cwd = root
else:
    raise ValueError('Unsupported mode')
def scrub(s):
    for val in [default[1], env['DATABASE_URL'], env['REDIS_URL']]:
        s = s.replace(val, '[local target URL omitted]')
    s = re.sub(r'(?:postgres(?:ql)?|redis)://[^\s\x1b\'\"]+', '[local target URL omitted]', s)
    s = re.sub(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[test bearer omitted]', s)
    s = re.sub(r'\+592\d+', '[synthetic phone omitted]', s)
    s = re.sub(r'ExponentPushToken\[[^\]]+\]', '[test device omitted]', s)
    s = re.sub(r'\x1b\[[0-9;]*m', '', s)
    return s
p = subprocess.run(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
s = 'Command: ' + ' '.join(cmd) + '\n' + scrub(p.stdout) + '\nEXIT: ' + str(p.returncode) + '\n'
(out / (name + '.log')).write_text(s)
print(s[-18000:])
sys.exit(p.returncode)
