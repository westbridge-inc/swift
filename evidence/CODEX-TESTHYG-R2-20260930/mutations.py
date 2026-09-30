"""Bounded test-only mutations; retain patches, red output and exact restoration hashes."""
from pathlib import Path
import difflib, hashlib, subprocess, sys
root = Path(__file__).resolve().parents[2]
out = Path(__file__).resolve().parent
case = sys.argv[1]
label = sys.argv[2] if len(sys.argv) > 2 else case
assert label.replace('-', '').isalnum()
paths = {
    'f1-old': 'golden/gold-7-helpers.ts',
    'f1-late': 'golden/gold-7-helpers.ts',
    'f2': 'helpers/order-hold-cleanup.ts',
    'f3': 'golden/gold-7-vend-04.test.ts',
    'f4': 'golden/gold-3-mover-online.test.ts',
    'f5': 'helpers/dashboard-clock.ts',
}
p = root / 'apps/api/src/__tests__' / paths[case]
landed = p.read_text()
args = {
    'f1-old': ['src/__tests__/golden/gold-7-cleanup.test.ts', '-t', 'refuses existing and post-preflight'],
    'f1-late': ['src/__tests__/golden/gold-7-cleanup.test.ts', '-t', 'refuses existing and post-preflight'],
    'f2': ['src/__tests__/order-hold-cleanup.test.ts'],
    'f3': ['src/__tests__/golden/gold-7-vend-04.test.ts', '-t', 'preserves a peer dunning alert'],
    'f4': ['src/__tests__/golden/gold-3-mover-online.test.ts', '-t', 'keeps the peer capacity-one'],
    'f5': ['src/__tests__/order-hold-journey.test.ts', '-t', 'synchronizes dashboard reads across'],
}[case]
if case == 'f1-old':
    mutant = subprocess.check_output(['git', 'show', '5f026c47b405083d6f8d3b91751d995061761af9:' + str(p.relative_to(root))], cwd=root, text=True)
elif case == 'f1-late':
    assert landed.count('        await assertNoForeignDependents(tx);') == 1
    mutant = landed.replace('        await assertNoForeignDependents(tx);', '        // MUTATION: omit locked recheck after empty preflight.')
elif case == 'f2':
    assert landed.count('    await guard(tx);') == 1
    mutant = landed.replace('    await guard(tx);', '    // MUTATION: omit locked recheck after empty preflight.')
elif case == 'f3':
    needle = 'await tx.alertDelivery.deleteMany({ where: { id: { in: [...messageInserts.alertIds] } } });'
    assert landed.count(needle) == 1
    mutant = landed.replace(needle, "await tx.alertDelivery.deleteMany({ where: { kind: 'ADMIN_OPS', subjectId: 'billing_dunning_ops_task', recipientId: { in: ids } } });")
elif case == 'f4':
    mutant = landed.replace('let restoreCapacityRead: (() => void) | undefined;', 'let restoreCapacityRead: (() => void) | undefined;\nlet mutantCapacityId: string | undefined;')
    start = mutant.index('  // Intercept only this client')
    end = mutant.index('  restoreCapacityRead = () => capacityRead.mockRestore();', start) + len('  restoreCapacityRead = () => capacityRead.mockRestore();')
    mutant = mutant[:start] + """  const latest = await sys(() => app.prisma.algoConfig.findFirst({ where: { tenantId: 'swift-default', key: 'stacking.riderCapacity' }, orderBy: { version: 'desc' } }));
  const shared = await sys(() => app.prisma.algoConfig.create({ data: { tenantId: 'swift-default', key: 'stacking.riderCapacity', value: 3, version: (latest?.version ?? 0) + 1, updatedBy: FIXTURE } }));
  mutantCapacityId = shared.id;
  invalidateAlgoConfig('swift-default', 'stacking.riderCapacity');""" + mutant[end:]
    mutant = mutant.replace('  restoreCapacityRead?.();', "  restoreCapacityRead?.();\n  if (mutantCapacityId) await sys(() => app.prisma.algoConfig.delete({ where: { id: mutantCapacityId } }));")
elif case == 'f5':
    mutant = 'export async function withDashboardClock<T>(_at: number, read: () => Promise<T>): Promise<T> { return read(); }\n'
assert mutant != landed
sha = lambda s: hashlib.sha256(s.encode()).hexdigest()
patch = ''.join(difflib.unified_diff(landed.splitlines(keepends=True), mutant.splitlines(keepends=True), fromfile=str(p.relative_to(root)), tofile=str(p.relative_to(root))))
(out / (label + '-mutation.patch')).write_text(patch)
receipt = ['Case: ' + case, 'LANDED SHA256: ' + sha(landed), 'MUTANT SHA256: ' + sha(mutant), 'Test command: run.py ' + label + '-mutation-red test ' + ' '.join(args)]
try:
    p.write_text(mutant)
    receipt.append('MUTATION LANDED: ' + str(sha(p.read_text()) == sha(mutant)))
    red = subprocess.call([sys.executable, str(out / 'run.py'), label + '-mutation-red', 'test', *args], cwd=root)
    receipt.append('RED EXIT: ' + str(red))
    log = (out / (label + '-mutation-red.log')).read_text()
    traversed = red != 0 and 'AssertionError:' in log and 'Test Files  1 failed' in log
    receipt.append('TRAVERSED assertion failure: ' + str(traversed))
finally:
    p.write_text(landed)
    receipt.append('RESTORED SHA256: ' + sha(p.read_text()))
    receipt.append('RESTORED EXACT: ' + str(p.read_text() == landed))
    (out / (label + '-mutation-receipt.txt')).write_text('\n'.join(receipt) + '\n')
assert traversed, 'Mutation failed to reach the expected regression assertion'
green = subprocess.call([sys.executable, str(out / 'run.py'), label + '-restored-green', 'test', *args], cwd=root)
receipt.append('RESTORED GREEN EXIT: ' + str(green))
(out / (label + '-mutation-receipt.txt')).write_text('\n'.join(receipt) + '\n')
print('\n'.join(receipt))
assert green == 0
