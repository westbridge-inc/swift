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
os.symlink(mobile / "node_modules", snapshot / "node_modules")
(snapshot / "vitest.config.ts").write_text(
    "import { defineConfig } from 'vitest/config';\n"
    "export default defineConfig({ test: { environment: 'node', include: ['src/**/*.test.ts'] } });\n"
)
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
     "if (profile.isError && !profile.data)", "if (profile.isError)",
     "src/lib/appSpeed.render.test.ts"),
    ("offline-mutation-queue", "src/lib/queryClient.ts",
     "networkMode: 'always'", "networkMode: 'online'",
     "src/lib/appQueryPolicy.test.ts"),
]
for name, relative, old, new, test in mutants:
    path = snapshot / relative
    original = path.read_text()
    assert original.count(old) == 1, f"ambiguous mutation: {name}"
    try:
        path.write_text(original.replace(old, new))
        result = subprocess.run(
            [str(snapshot / "node_modules/.bin/vitest"), "run", "--config", "vitest.config.ts", "--maxWorkers=2", test],
            cwd=snapshot, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        (snapshot / f"{name}.log").write_text(result.stdout)
        summary = [line.strip() for line in result.stdout.splitlines() if "Tests " in line or "Test Files " in line]
        assert result.returncode == 1 and "AssertionError" in result.stdout and "Unhandled Errors" not in result.stdout, f"mutant not assertion-killed: {name}\n{result.stdout}"
        print(f"KILLED {name}: {'; '.join(summary)}", flush=True)
    finally:
        path.write_text(original)
print(f"Evidence: {snapshot}", flush=True)
