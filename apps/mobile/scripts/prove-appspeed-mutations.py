#!/usr/bin/env python3
"""Run real regression tests against isolated source mutants, never the worktree.

Use the existing dependency symlink; no install, device, API or credentials.
Keep the temporary snapshot and logs as reproducible review evidence.
"""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

mobile = Path(__file__).resolve().parents[1]
snapshot = Path(tempfile.mkdtemp(prefix="appspeed-mutations-", dir="/private/tmp"))
shutil.copytree(mobile / "src", snapshot / "src", ignore=shutil.ignore_patterns(".env", ".env.*"))
shutil.copyfile(mobile / "app.config.ts", snapshot / "app.config.ts")
os.symlink(mobile / "node_modules", snapshot / "node_modules")
(snapshot / "vitest.config.ts").write_text(
    "import { defineConfig } from 'vitest/config';\n"
    "export default defineConfig({ test: { environment: 'node', include: ['src/**/*.test.ts'] } });\n"
)

def run(name, tests, expected):
    result = subprocess.run(
        [str(snapshot / "node_modules/.bin/vitest"), "run", "--config", "vitest.config.ts", "--maxWorkers=2", *tests],
        cwd=snapshot, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    (snapshot / f"{name}.log").write_text(result.stdout)
    summary = [line.strip() for line in result.stdout.splitlines() if "Tests " in line or "Test Files " in line]
    assert result.returncode == expected and not any(
        problem in result.stdout for problem in ["Unhandled Errors", "RangeError", "ReferenceError"]
    ), f"unexpected result: {name}\n{result.stdout}"
    if expected:
        assert "AssertionError" in result.stdout, f"not assertion-killed: {name}\n{result.stdout}"
    print(f"{name}: {'; '.join(summary)}", flush=True)
    return result.stdout

revision_tests = ["src/lib/appQueryPolicy.test.ts", "src/lib/appSpeed.render.test.ts",
                  "src/services/api.replay-auth.test.ts", "src/components/OfflineBanner.test.ts"]
# New tests over exact review-head production code, without changing Git HEAD.
baseline_files = ["src/lib/appQueryPolicy.ts", "src/lib/queryClient.ts", "src/services/api.ts",
                  "src/modules/profile/screens/ProfileScreen.tsx", "src/components/OfflineBanner.tsx"]
originals = {relative: (snapshot / relative).read_text() for relative in baseline_files}
try:
    for relative in baseline_files:
        old_source = subprocess.check_output(
            ["git", "show", f"8898e2f2:apps/mobile/{relative}"], cwd=mobile, text=True,
        )
        (snapshot / relative).write_text(old_source)
    output = run("OLD-8898e2f2-F1-F5", [*revision_tests, "-t", "F[1-5]:"], 1)
    for finding in range(1, 6):
        assert any("FAIL " in line and f"F{finding}:" in line for line in output.splitlines()), f"F{finding} did not fail on old code"
finally:
    for relative, source in originals.items():
        (snapshot / relative).write_text(source)

mutants = [
    ("scope-wipe", "src/lib/appQueryPolicy.ts",
     "client.clear(); // Cancel old reads/retries", "/* omitted wipe */ // Cancel old reads/retries",
     "src/stores/queryScope.test.ts"),
    ("critical-freshness", "src/lib/appQueryPolicy.ts",
     "client.setQueryDefaults(key, { staleTime: 0 });", "client.setQueryDefaults(key, { staleTime: 60_000 });",
     "src/lib/appQueryPolicy.test.ts"),
    ("reconnect-storm", "src/lib/appQueryPolicy.ts",
     "now - previous < RECONNECT_COOLDOWN_MS",
     "now - previous < 0",
     "src/lib/appQueryPolicy.test.ts"),
    ("profile-cache", "src/modules/profile/screens/ProfileScreen.tsx",
     "if (profile.isError && (!profile.data || !retryRead(0, profile.error)))", "if (profile.isError)",
     "src/lib/appSpeed.render.test.ts"),
    ("offline-mutation-queue", "src/lib/queryClient.ts",
     "networkMode: 'always'", "networkMode: 'online'",
     "src/lib/appQueryPolicy.test.ts"),
    ("F1-availability", "src/lib/appQueryPolicy.ts",
     "client.setQueryDefaults(key, { staleTime: 0 });",
     "client.setQueryDefaults(key, { staleTime: key[0] === 'customer' && key[1] === 'vendor' ? BROWSE_FRESH_MS : 0 });",
     "src/lib/appQueryPolicy.test.ts"),
    ("F2-default-live", "src/lib/queryClient.ts",
     "staleTime: 0,", "staleTime: 30_000,",
     "src/lib/appQueryPolicy.test.ts"),
    ("F3-lost-intent", "src/lib/appQueryPolicy.ts",
     "if (query.state.fetchStatus !== 'idle') return;", "if (query.state.fetchStatus !== 'idle') { remove(query); return; }",
     "src/lib/appQueryPolicy.test.ts"),
    ("F3-cancel-revival", "src/lib/appQueryPolicy.ts",
     "pending.delete(query);",
     "const revive = pending.get(query)?.due; pending.delete(query);\n    if (revive) setTimeout(() => { void query.fetch().catch(() => undefined); }, 0);",
     "src/lib/appQueryPolicy.test.ts"),
    ("F4-terminal-signout", "src/services/api.ts",
     "useAuthStore.getState().logoutIfCurrent(captured);", "/* terminal sign-out omitted */",
     "src/services/api.replay-auth.test.ts"),
    ("F4-exact-session", "src/services/api.ts",
     "useAuthStore.getState().logoutIfCurrent(captured);", "useAuthStore.getState().logoutIfCurrent(getAuthSessionSnapshot()!);",
     "src/services/api.replay-auth.test.ts"),
    ("F4-recoverable-session", "src/services/api.ts",
     "error.response?.status === 401\n      && originalRequest", "true\n      && originalRequest",
     "src/services/api.replay-auth.test.ts"),
    ("F4-profile-rejection", "src/modules/profile/screens/ProfileScreen.tsx",
     "!profile.data || !retryRead(0, profile.error)", "!profile.data",
     "src/lib/appSpeed.render.test.ts"),
    ("F4-profile-signedout", "src/modules/profile/screens/ProfileScreen.tsx",
     "if (!isAuthenticated)", "if (false)",
     "src/lib/appSpeed.render.test.ts"),
    ("F5-offline-copy", "src/components/OfflineBanner.tsx",
     "You're offline. Some things may not load until you're back online.", "No connection — saved content is still available",
     "src/components/OfflineBanner.test.ts"),
    ("reviewed-allowlist", "src/lib/appQueryPolicy.ts",
     "staleTime: BROWSE_FRESH_MS", "staleTime: 0",
     "src/lib/appQueryPolicy.test.ts"),
]
for name, relative, old, new, test in mutants:
    path = snapshot / relative
    original = path.read_text()
    assert original.count(old) == 1, f"ambiguous mutation: {name}"
    try:
        path.write_text(original.replace(old, new))
        run(f"KILLED-{name}", [test], 1)
    finally:
        path.write_text(original)
    assert path.read_text() == original, f"source not restored: {name}"
run("RESTORED", [*revision_tests, "src/stores/queryScope.test.ts"], 0)
print(f"Evidence: {snapshot}", flush=True)
