from pathlib import Path
import subprocess, sys
root = Path(__file__).resolve().parents[2]
out = Path(__file__).resolve().parent
paths = [
    'src/__tests__/fairness-band.test.ts',
    'src/__tests__/golden/gold-3-mover-online.test.ts',
    'src/__tests__/golden/gold-7-admin-04.test.ts',
    'src/__tests__/golden/gold-7-cleanup.test.ts',
    'src/__tests__/golden/gold-7-vend-04.test.ts',
    'src/__tests__/order-hold-journey.test.ts',
    'src/__tests__/usd-migration-tenant.test.ts',
    'src/__tests__/usd-pricing-pinning.test.ts',
    'src/__tests__/order-hold-cleanup.test.ts',
    'src/__tests__/audit-append-only.test.ts',
]
for name, args in [(f'affected-repeat-{i}', paths) for i in range(1,4)] + [(f'golden-repeat-{i}', ['src/__tests__/golden']) for i in range(1,3)]:
    disk = subprocess.check_output(['df','-k',str(root)], text=True)
    (out / (name + '-disk.log')).write_text('Command: df -k worktree\n' + disk)
    available_kib = int(disk.splitlines()[-1].split()[3])
    print(name, 'available GiB:', round(available_kib / 1048576, 3), flush=True)
    if available_kib < 15 * 1048576 and name.startswith('golden'):
        (out / (name + '-HELD.txt')).write_text('Full local golden suite HELD: available disk below 15 GiB. Full CI required; no files deleted.\n')
        raise SystemExit(3)
    r = subprocess.run([sys.executable, str(out / 'run.py'), name, 'test', *args], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    print(r.stdout[-1400:], flush=True)
    if r.returncode: raise SystemExit(r.returncode)
