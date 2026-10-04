#!/usr/bin/env bash
# audit/run.sh — the deterministic layer of the Swift audit.
#
# Runs locally available scanners over the repository and git history, preserves
# scanner exit status, and writes machine-readable evidence to audit/out/.
#
# Usage:
#   bash audit/run.sh                 # full run
#   AUDIT_QUICK=1 bash audit/run.sh   # skip the slow stages (trivy, knip, tsc loop)
#   AUDIT_DB_APPROVED=1 AUDIT_ALLOWED_DATABASE=... \
#     AUDIT_DATABASE_URL=postgresql://...@127.0.0.1:5434/... bash audit/run.sh
#
# Optional stages (off unless configured):
#   SONAR_HOST_URL + SONAR_TOKEN      → SonarQube scan (Community Build, self-hosted)
#
# Nothing here modifies tracked source. No package installer or unpinned npx
# command is invoked. Everything lands in ignored audit/out/.

set -uo pipefail

PATH="/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export PATH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUD="$ROOT/audit"
OUT="$AUD/out"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
QUICK="${AUDIT_QUICK:-0}"

mkdir -p "$OUT"
cd "$ROOT"

log()  { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
SKIPPED=()
skip() { SKIPPED+=("$1"); note "skipped: $1"; }
STATUS_FILE="$OUT/stages.tsv"
printf 'stage\tstatus\texit_code\tnote\n' > "$STATUS_FILE"
record() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$STATUS_FILE"; }

# ---------- package manager detection ----------
if   [ -f pnpm-lock.yaml ]; then PM=pnpm
elif [ -f yarn.lock ];      then PM=yarn
elif [ -f bun.lockb ] || [ -f bun.lock ]; then PM=bun
else                             PM=npm
fi
EXCL_DIRS='node_modules,dist,build,.next,.turbo,.expo,coverage,ios/Pods,android/build,android/.gradle,src-tauri/target,audit/out'
NODE_BIN="$ROOT/node_modules/.bin"
NODE_DEPS=0
[ -d "$ROOT/node_modules" ] && NODE_DEPS=1

# ---------- isolated database authorization ----------
DB_ENABLED=0
DB_REFUSAL="not requested"
if [ -n "${AUDIT_DATABASE_URL:-}" ] || [ -n "${AUDIT_ALLOWED_DATABASE:-}" ] || [ "${AUDIT_DB_APPROVED:-0}" = "1" ]; then
  if [ "${AUDIT_DB_APPROVED:-0}" != "1" ] || [ -z "${AUDIT_DATABASE_URL:-}" ] || [ -z "${AUDIT_ALLOWED_DATABASE:-}" ]; then
    DB_REFUSAL="all of AUDIT_DB_APPROVED=1, AUDIT_ALLOWED_DATABASE, and AUDIT_DATABASE_URL are required"
  elif ! have node; then
    DB_REFUSAL="Node.js is required to parse the URL without printing it"
  else
    db_parts="$(AUDIT_PARSE_URL="$AUDIT_DATABASE_URL" node - <<'NODE' 2>/dev/null
try {
  const url = new URL(process.env.AUDIT_PARSE_URL);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) process.exit(2);
  process.stdout.write([url.hostname, url.port, database].join('\t'));
} catch {
  process.exit(2);
}
NODE
)"
    db_parse_rc=$?
    IFS=$'\t' read -r db_host db_port db_name <<< "$db_parts"
    case "${AUDIT_ALLOWED_DATABASE:-}" in
      swift|swift_test|swift_test2|postgres|template0|template1) DB_REFUSAL="database name is reserved or belongs to another lane" ;;
      *)
        if [ "$db_parse_rc" -ne 0 ]; then
          DB_REFUSAL="database URL could not be parsed"
        elif [ "$db_host" != "127.0.0.1" ] && [ "$db_host" != "localhost" ] && [ "$db_host" != "::1" ]; then
          DB_REFUSAL="database host is not loopback"
        elif [ "$db_port" != "5434" ]; then
          DB_REFUSAL="database port is not the isolated port 5434"
        elif [ "$db_name" != "$AUDIT_ALLOWED_DATABASE" ]; then
          DB_REFUSAL="parsed database name does not match AUDIT_ALLOWED_DATABASE"
        else
          DB_ENABLED=1
          DB_REFUSAL=""
        fi
        ;;
    esac
  fi
fi

# ---------- run log ----------
exec > >(tee "$OUT/run.log") 2>&1
log "Swift audit — deterministic layer — $STAMP"
note "repo: $ROOT"
note "package manager: $PM"
note "git HEAD: $(git rev-parse --short HEAD 2>/dev/null || echo 'not a git repo')"

# =====================================================================
# 1. SEMGREP — security + quality patterns, community packs + Swift rules
# =====================================================================
log "1/12 semgrep"
if have semgrep; then
  SG_COMMON=(--metrics=off --timeout 90 --max-target-bytes 2000000
    --exclude node_modules --exclude dist --exclude build --exclude .next --exclude .turbo
    --exclude ios/Pods --exclude android/build --exclude src-tauri/target --exclude audit/out)
  # Pass A is repository-pinned and works offline.
  semgrep scan --config "$AUD/rules/" "${SG_COMMON[@]}" --json --output "$OUT/semgrep-swift.json" . >/dev/null
  sg_local_rc=$?
  record "semgrep-local" "COMPLETED" "$sg_local_rc" "repository-pinned rules"

  # Registry aliases are mutable. They are useful discovery evidence only and
  # are never fetched silently by this harness.
  if [ "${AUDIT_REMOTE_RULES_APPROVED:-0}" = "1" ]; then
    semgrep scan \
      --config p/default --config p/security-audit --config p/owasp-top-ten \
      --config p/typescript --config p/javascript --config p/nodejs \
      --config p/react --config p/nextjs \
      --config p/secrets --config p/jwt --config p/sql-injection --config p/xss --config p/command-injection \
      --config p/docker --config p/dockerfile --config p/github-actions \
      "${SG_COMMON[@]}" --json --output "$OUT/semgrep-community.json" . >/dev/null
    sg_remote_rc=$?
    record "semgrep-community" "DISCOVERY_ONLY" "$sg_remote_rc" "mutable remote registry packs"
  else
    skip "semgrep community packs (mutable remote rules; set AUDIT_REMOTE_RULES_APPROVED=1 for discovery only)"
    record "semgrep-community" "SKIPPED" "-" "remote rule fetch not approved"
  fi
  if have jq; then
    for f in semgrep-swift semgrep-community; do
      if [ -f "$OUT/$f.json" ]; then
        note "$f: $(jq '.results | length' "$OUT/$f.json") findings (ERROR: $(jq '[.results[]|select(.extra.severity=="ERROR")]|length' "$OUT/$f.json"), WARNING: $(jq '[.results[]|select(.extra.severity=="WARNING")]|length' "$OUT/$f.json")), scan errors: $(jq '.errors | length' "$OUT/$f.json")"
      fi
    done
    if [ "$(jq '[.errors[]|select(.message|test("Failed to download"))]|length' "$OUT/semgrep-community.json" 2>/dev/null || echo 0)" != "0" ]; then
      note "WARNING: community packs could not be downloaded (no access to semgrep.dev?) — only Swift rules ran"
    fi
  fi
else
  skip "semgrep (bash audit/install.sh)"
  record "semgrep-local" "SKIPPED" "-" "binary unavailable"
fi

# =====================================================================
# 2. GITLEAKS — secrets in the WHOLE git history, not just the working tree
# =====================================================================
log "2/12 gitleaks (full history)"
if have gitleaks; then
  if gitleaks git --help >/dev/null 2>&1; then
    gitleaks git --redact --report-format json --report-path "$OUT/gitleaks.json" --exit-code 0 --no-banner . >"$OUT/gitleaks.log" 2>&1
  else
    gitleaks detect --redact --source . --report-format json --report-path "$OUT/gitleaks.json" --exit-code 0 --no-banner >"$OUT/gitleaks.log" 2>&1
  fi
  gl_rc=$?
  [ -f "$OUT/gitleaks.json" ] || echo '[]' > "$OUT/gitleaks.json"
  chmod 600 "$OUT/gitleaks.json" "$OUT/gitleaks.log" 2>/dev/null || true
  have jq && note "leaks: $(jq 'length' "$OUT/gitleaks.json")"
  record "gitleaks-history" "COMPLETED_REDACTED" "$gl_rc" "report redacted"
else
  skip "gitleaks"
  record "gitleaks-history" "SKIPPED" "-" "binary unavailable"
fi

# =====================================================================
# 3. TRUFFLEHOG (optional) — only VERIFIED live credentials, history-wide
# =====================================================================
log "3/12 trufflehog (verified secrets, explicit opt-in)"
if [ "${AUDIT_VERIFY_SECRETS:-0}" != "1" ]; then
  skip "trufflehog live verification (set AUDIT_VERIFY_SECRETS=1 only after external-provider approval)"
  record "trufflehog-verified" "SKIPPED" "-" "external credential verification not approved"
elif have trufflehog && have jq; then
  # Never persist Raw, RawV2, ExtraData, author identity, repository URL, or
  # unbounded detector output. jq receives the stream directly and emits only
  # the evidence needed to locate a candidate for manual handling.
  trufflehog git "file://$ROOT" --only-verified --json --no-update 2>"$OUT/trufflehog.log" \
    | jq -c '{DetectorName,Verified,VerificationFromCache,git:((.SourceMetadata.Data.Git // {}) | {commit,file,line})}' \
    >"$OUT/trufflehog-sanitized.jsonl"
  th_rc=${PIPESTATUS[0]}
  chmod 600 "$OUT/trufflehog-sanitized.jsonl" "$OUT/trufflehog.log" 2>/dev/null || true
  note "verified-secret metadata records: $(grep -c . "$OUT/trufflehog-sanitized.jsonl" 2>/dev/null || echo 0)"
  record "trufflehog-verified" "COMPLETED_SANITIZED" "$th_rc" "raw credential values were not persisted"
else
  skip "trufflehog verified scan (requires trufflehog and jq)"
  record "trufflehog-verified" "SKIPPED" "-" "binary unavailable"
fi

# =====================================================================
# 4. TRIVY — dependency CVEs + secrets + Dockerfile/IaC misconfig
# =====================================================================
log "4/12 trivy (dependency and configuration evidence)"
if [ "$QUICK" = "1" ]; then
  skip "trivy (AUDIT_QUICK=1)"
  record "trivy" "SKIPPED" "-" "quick mode"
elif have trivy; then
  TRIVY_SKIP_DB_UPDATE=true TRIVY_SKIP_JAVA_DB_UPDATE=true TRIVY_SKIP_CHECK_UPDATE=true \
  trivy fs --scanners vuln,misconfig --format json --output "$OUT/trivy.json" \
    --skip-dirs node_modules --skip-dirs .next --skip-dirs dist --skip-dirs ios/Pods --skip-dirs android/build \
    --quiet .
  trivy_rc=$?
  record "trivy" "COMPLETED_OFFLINE" "$trivy_rc" "database and policy updates disabled"
  if have jq && [ -f "$OUT/trivy.json" ]; then
    note "vulns: $(jq '[.Results[]?.Vulnerabilities[]?] | length' "$OUT/trivy.json") (CRITICAL: $(jq '[.Results[]?.Vulnerabilities[]?|select(.Severity=="CRITICAL")]|length' "$OUT/trivy.json"), HIGH: $(jq '[.Results[]?.Vulnerabilities[]?|select(.Severity=="HIGH")]|length' "$OUT/trivy.json"))"
    note "misconfigs: $(jq '[.Results[]?.Misconfigurations[]?] | length' "$OUT/trivy.json")"
  fi
else
  skip "trivy"
  record "trivy" "SKIPPED" "-" "binary unavailable"
fi

# =====================================================================
# 5. OSV-SCANNER (optional) + native package-manager audit
# =====================================================================
log "5/12 osv-scanner + $PM audit"
if have osv-scanner; then
  osv-scanner scan source -r --format json --output "$OUT/osv.json" . >/dev/null 2>&1 \
    || osv-scanner -r --format json --output "$OUT/osv.json" . >/dev/null 2>&1
  osv_rc=$?
  record "osv-scanner" "COMPLETED" "$osv_rc" "source dependency scan"
  have jq && [ -f "$OUT/osv.json" ] && note "osv vulns: $(jq '[.results[]?.packages[]?.vulnerabilities[]?] | length' "$OUT/osv.json")"
else
  skip "osv-scanner (optional; trivy covers deps)"
  record "osv-scanner" "SKIPPED" "-" "binary unavailable"
fi
case "$PM" in
  pnpm) pnpm audit --json >"$OUT/pm-audit.json" 2>"$OUT/pm-audit.log" ;;
  npm)  npm audit --json  >"$OUT/pm-audit.json" 2>"$OUT/pm-audit.log" ;;
  yarn) (yarn npm audit --json || yarn audit --json) >"$OUT/pm-audit.json" 2>"$OUT/pm-audit.log" ;;
  bun)  bun audit --json  >"$OUT/pm-audit.json" 2>"$OUT/pm-audit.log" ;;
esac
pm_audit_rc=$?
record "package-audit" "COMPLETED" "$pm_audit_rc" "$PM audit"
[ -s "$OUT/pm-audit.json" ] && note "$PM audit written"

# =====================================================================
# 6. TYPESCRIPT — every tsconfig in the monorepo, no emit
# =====================================================================
log "6/12 tsc --noEmit (every tsconfig.json)"
: > "$OUT/tsc.txt"
if [ "$QUICK" = "1" ]; then
  skip "tsc loop (AUDIT_QUICK=1)"
  record "typescript" "SKIPPED" "-" "quick mode"
elif [ "$NODE_DEPS" != "1" ] || [ ! -x "$NODE_BIN/tsc" ]; then
  skip "tsc loop (repository dependencies are not installed; no package download attempted)"
  record "typescript" "SKIPPED" "-" "node_modules/.bin/tsc unavailable"
else
  tsc_rc=0
  while IFS= read -r cfg; do
    d="$(dirname "$cfg")"
    printf '\n### %s\n' "$d" >> "$OUT/tsc.txt"
    (cd "$d" && "$NODE_BIN/tsc" --noEmit -p tsconfig.json --pretty false) >> "$OUT/tsc.txt" 2>&1 || tsc_rc=1
  done < <(find . -name tsconfig.json \
              -not -path '*/node_modules/*' -not -path '*/.next/*' -not -path '*/dist/*' \
              -not -path '*/build/*' -not -path '*/.turbo/*' | sort)
  note "type errors: $(grep -c 'error TS' "$OUT/tsc.txt" || true)"
  record "typescript" "COMPLETED" "$tsc_rc" "every discovered tsconfig"
fi

# =====================================================================
# 7. ESLINT — the repo's own config, JSON out
# =====================================================================
log "7/12 eslint"
if [ "$NODE_DEPS" != "1" ] || [ ! -x "$NODE_BIN/eslint" ]; then
  skip "eslint (repository dependencies are not installed; no package download attempted)"
  record "eslint" "SKIPPED" "-" "node_modules/.bin/eslint unavailable"
else
  "$NODE_BIN/eslint" . -f json -o "$OUT/eslint.json" --no-error-on-unmatched-pattern >"$OUT/eslint.log" 2>&1
  eslint_rc=$?
  record "eslint" "COMPLETED" "$eslint_rc" "repository configuration"
fi
if have jq && [ -f "$OUT/eslint.json" ]; then
  note "errors: $(jq '[.[].errorCount] | add // 0' "$OUT/eslint.json")   warnings: $(jq '[.[].warningCount] | add // 0' "$OUT/eslint.json")"
else
  note "eslint produced no JSON — see $OUT/eslint.log (no config? flat-config mismatch?)"
fi

# =====================================================================
# 8. KNIP — dead code, unused exports/files/deps across the Turborepo
# =====================================================================
log "8/12 knip (dead code / unused deps)"
if [ "$QUICK" = "1" ]; then
  skip "knip (AUDIT_QUICK=1)"
  record "knip" "SKIPPED" "-" "quick mode"
elif [ "$NODE_DEPS" != "1" ] || [ ! -x "$NODE_BIN/knip" ]; then
  skip "knip (repository dependencies are not installed; no package download attempted)"
  record "knip" "SKIPPED" "-" "node_modules/.bin/knip unavailable"
else
  "$NODE_BIN/knip" --reporter json --no-progress >"$OUT/knip.json" 2>"$OUT/knip.log"
  knip_rc=$?
  record "knip" "COMPLETED" "$knip_rc" "repository configuration"
  if have jq && jq -e . "$OUT/knip.json" >/dev/null 2>&1; then
    note "unused files: $(jq '.files | length' "$OUT/knip.json")   issues (exports/deps/types): $(jq '[.issues[]? | (.exports|length) + (.dependencies|length) + (.devDependencies|length) + (.types|length)] | add // 0' "$OUT/knip.json")"
  else
    note "knip produced no JSON — see $OUT/knip.log"
  fi
fi

# =====================================================================
# 9. MADGE — circular imports
# =====================================================================
log "9/12 madge (circular dependencies)"
DIRS=()
for d in apps packages src; do [ -d "$d" ] && DIRS+=("$d"); done
if [ ${#DIRS[@]} -gt 0 ] && [ "$NODE_DEPS" = "1" ] && [ -x "$NODE_BIN/madge" ]; then
  "$NODE_BIN/madge" --circular --extensions ts,tsx,js,jsx --exclude 'node_modules|\.next|dist|build' --json "${DIRS[@]}" >"$OUT/madge.json" 2>"$OUT/madge.log"
  madge_rc=$?
  record "madge" "COMPLETED" "$madge_rc" "repository source graph"
  have jq && jq -e . "$OUT/madge.json" >/dev/null 2>&1 && note "circular chains: $(jq 'length' "$OUT/madge.json")"
else
  skip "madge (source directories or installed repository binary unavailable)"
  record "madge" "SKIPPED" "-" "requirements unavailable"
fi

# =====================================================================
# 10. PRISMA — schema validity; live status only on the assigned isolated DB
# =====================================================================
log "10/12 prisma"
: > "$OUT/prisma.txt"
if [ "$NODE_DEPS" != "1" ] || [ ! -x "$NODE_BIN/prisma" ]; then
  skip "prisma validation (repository dependencies are not installed; no package download attempted)"
  record "prisma" "SKIPPED" "-" "node_modules/.bin/prisma unavailable"
else
  prisma_rc=0
  while IFS= read -r schema; do
    printf '\n### %s\n' "$schema" >> "$OUT/prisma.txt"
    "$NODE_BIN/prisma" validate --schema "$schema" >> "$OUT/prisma.txt" 2>&1 || prisma_rc=1
    if [ "$DB_ENABLED" = "1" ]; then
      printf -- '--- migrate status on explicitly assigned isolated database\n' >> "$OUT/prisma.txt"
      DATABASE_URL="$AUDIT_DATABASE_URL" "$NODE_BIN/prisma" migrate status --schema "$schema" >> "$OUT/prisma.txt" 2>&1 || prisma_rc=1
    fi
  done < <(find . -name 'schema.prisma' -not -path '*/node_modules/*' | sort)
  note "written: $OUT/prisma.txt"
  record "prisma" "COMPLETED" "$prisma_rc" "schema validate and authorized status only"
fi

# =====================================================================
# 11. LIVE POSTGRES CHECKS — RLS, tenancy, float money, unindexed FKs, roles
# =====================================================================
log "11/12 postgres checks (db-checks.sql)"
if [ "$DB_ENABLED" = "1" ] && have psql; then
  PGCONNECT_TIMEOUT=5 psql "$AUDIT_DATABASE_URL" -v ON_ERROR_STOP=0 -X -f "$AUD/db-checks.sql" >"$OUT/db-checks.txt" 2>&1
  db_rc=$?
  note "written: $OUT/db-checks.txt"
  record "postgres-checks" "COMPLETED_ASSIGNED_DB" "$db_rc" "database=$AUDIT_ALLOWED_DATABASE host=loopback port=5434"
else
  skip "postgres checks ($DB_REFUSAL)"
  record "postgres-checks" "SKIPPED" "-" "$DB_REFUSAL"
fi

# =====================================================================
# 12. REPO HYGIENE GREPS — cheap signals the LLM should see
# =====================================================================
log "12/12 hygiene greps"
H="$OUT/hygiene.txt"
: > "$H"
sec() { printf '\n## %s\n' "$1" >> "$H"; }
GREP_EXCL='--exclude-dir=node_modules --exclude-dir=.next --exclude-dir=dist --exclude-dir=build --exclude-dir=.turbo --exclude-dir=coverage --exclude-dir=Pods --exclude-dir=out'

sec "Tracked .env / key / cert files (should be NONE)"
git ls-files 2>/dev/null | grep -Ei '(^|/)\.env($|\.)|\.(pem|p12|jks|keystore|key|mobileprovision)$|google-services\.json$|GoogleService-Info\.plist$' >> "$H" || echo "(none)" >> "$H"

sec "Client-exposed env names that look like secrets (NEXT_PUBLIC_/EXPO_PUBLIC_)"
grep -rEn $GREP_EXCL --include='*.ts' --include='*.tsx' --include='*.js' --include='*.json' --include='.env*' \
  '(NEXT_PUBLIC|EXPO_PUBLIC)_[A-Z0-9_]*(SECRET|PRIVATE|SERVICE|API_KEY|TOKEN|PASSWORD)' . >> "$H" || echo "(none)" >> "$H"

sec "Blobs > 5MB anywhere in git history"
BLOBS="$(git rev-list --objects --all 2>/dev/null \
  | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' 2>/dev/null \
  | awk '$1=="blob" && $3>5000000 {printf "%.1fMB %s\n",$3/1048576,$4}' | sort -rn | head -n 40)"
[ -n "$BLOBS" ] && echo "$BLOBS" >> "$H" || echo "(none)" >> "$H"

sec "Suppression counts (each one needs a written justification)"
for pat in '@ts-ignore' '@ts-expect-error' 'eslint-disable' 'nosemgrep' ': any\b' 'as any\b' '!\.' 'TODO' 'FIXME' 'HACK' 'XXX'; do
  printf '%-18s %s\n' "$pat" "$(grep -rE $GREP_EXCL --include='*.ts' --include='*.tsx' -- "$pat" . 2>/dev/null | wc -l | tr -d ' ')" >> "$H"
done

sec "Disabled / focused tests"
grep -rEn $GREP_EXCL --include='*.test.*' --include='*.spec.*' -E '\.(skip|only|todo)\(|^\s*x(it|describe|test)\(' . >> "$H" || echo "(none)" >> "$H"

sec "console.log in server code (apps/api, packages) — should be structured logger"
grep -rEn $GREP_EXCL --include='*.ts' -E 'console\.(log|debug|info)\(' apps/api packages 2>/dev/null | wc -l | tr -d ' ' >> "$H"

sec "Raw SQL surface"
grep -rEn $GREP_EXCL --include='*.ts' -E '\$(queryRaw|executeRaw)(Unsafe)?' . >> "$H" || echo "(none)" >> "$H"

sec "Fastify routes without a schema (2-arg registration) — approximate count"
grep -rEn $GREP_EXCL --include='*.ts' -E '\.(get|post|put|patch|delete)\(\s*['"'"'"`][^'"'"'"`]+['"'"'"`]\s*,\s*(async\s*)?\(' apps packages 2>/dev/null | wc -l | tr -d ' ' >> "$H"

sec "Mock / placeholder / fake data still referenced in app code"
grep -rEn $GREP_EXCL --include='*.ts' --include='*.tsx' -iE '\b(mockData|fakeData|dummyData|placeholderData|TODO: wire|lorem ipsum|hardcoded)\b' apps 2>/dev/null | head -n 100 >> "$H" || echo "(none)" >> "$H"

sec "Repo size / shape"
{ printf 'tracked files: %s\n' "$(git ls-files 2>/dev/null | wc -l | tr -d ' ')";
  printf 'TS/TSX files:  %s\n' "$(git ls-files 2>/dev/null | grep -cE '\.tsx?$')";
  printf 'TS/TSX lines:  %s\n' "$(git ls-files 2>/dev/null | grep -E '\.tsx?$' | xargs wc -l 2>/dev/null | tail -n1 | awk '{print $1}')";
  printf 'test files:    %s\n' "$(git ls-files 2>/dev/null | grep -cE '\.(test|spec)\.[tj]sx?$')";
  printf 'migrations:    %s\n' "$(find . -path '*/prisma/migrations/*' -name 'migration.sql' -not -path '*/node_modules/*' 2>/dev/null | wc -l | tr -d ' ')";
  printf 'workspaces:    %s\n' "$(find apps packages -maxdepth 2 -name package.json 2>/dev/null | wc -l | tr -d ' ')";
} >> "$H"
note "written: $H"

# =====================================================================
# OPTIONAL: SONARQUBE (Community Build) — only if configured
# =====================================================================
if [ "${AUDIT_SONAR_APPROVED:-0}" = "1" ] && [ -n "${SONAR_HOST_URL:-}" ] && [ -n "${SONAR_TOKEN:-}" ]; then
  log "optional: sonar-scanner → $SONAR_HOST_URL"
  if have sonar-scanner && [[ "$SONAR_HOST_URL" =~ ^https?://(127\.0\.0\.1|localhost)(:[0-9]+)?(/|$) ]]; then
    sonar-scanner -Dsonar.projectKey="${SONAR_PROJECT_KEY:-swift}" -Dsonar.sources=. \
      -Dsonar.exclusions="**/node_modules/**,**/.next/**,**/dist/**,**/build/**,**/ios/Pods/**,**/android/build/**,audit/out/**" \
      -Dsonar.host.url="$SONAR_HOST_URL" >"$OUT/sonar.log" 2>&1
    sonar_rc=$?
    record "sonarqube" "COMPLETED_LOCAL" "$sonar_rc" "explicitly approved loopback server"
    note "see $OUT/sonar.log and the SonarQube UI"
  else
    skip "sonarqube (scanner missing or host is not loopback)"
    record "sonarqube" "SKIPPED" "-" "only an explicitly approved loopback server is permitted"
  fi
else
  record "sonarqube" "SKIPPED" "-" "not explicitly approved"
fi

# =====================================================================
# SUMMARY
# =====================================================================
log "summary → $OUT/SUMMARY.md"
S="$OUT/SUMMARY.md"
{
  echo "# Swift audit — scanner summary"
  echo
  echo "- run: $STAMP"
  echo "- git: $(git rev-parse --short HEAD 2>/dev/null || echo n/a) on $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo n/a)"
  echo "- package manager: $PM"
  echo
  echo "| stage | file | headline |"
  echo "|---|---|---|"
  if have jq; then
    [ -f "$OUT/semgrep-swift.json" ] && echo "| semgrep (Swift rules) | out/semgrep-swift.json | $(jq '.results|length' "$OUT/semgrep-swift.json") findings, $(jq '[.results[]|select(.extra.severity=="ERROR")]|length' "$OUT/semgrep-swift.json") ERROR |"
    [ -f "$OUT/semgrep-community.json" ]   && echo "| semgrep (community packs; discovery only) | out/semgrep-community.json | $(jq '.results|length' "$OUT/semgrep-community.json") findings, $(jq '[.results[]|select(.extra.severity=="ERROR")]|length' "$OUT/semgrep-community.json") ERROR, $(jq '.errors|length' "$OUT/semgrep-community.json") scan errors |"
    [ -f "$OUT/gitleaks.json" ]  && echo "| gitleaks | out/gitleaks.json | $(jq 'length' "$OUT/gitleaks.json") secrets in history |"
    [ -f "$OUT/trufflehog-sanitized.jsonl" ] && echo "| trufflehog | out/trufflehog-sanitized.jsonl | $(grep -c . "$OUT/trufflehog-sanitized.jsonl" 2>/dev/null || echo 0) verified-secret metadata records; raw values not persisted |"
    [ -f "$OUT/trivy.json" ]     && echo "| trivy | out/trivy.json | $(jq '[.Results[]?.Vulnerabilities[]?]|length' "$OUT/trivy.json") vulns ($(jq '[.Results[]?.Vulnerabilities[]?|select(.Severity=="CRITICAL" or .Severity=="HIGH")]|length' "$OUT/trivy.json") crit/high), $(jq '[.Results[]?.Misconfigurations[]?]|length' "$OUT/trivy.json") misconfigs |"
    [ -f "$OUT/eslint.json" ]    && echo "| eslint | out/eslint.json | $(jq '[.[].errorCount]|add//0' "$OUT/eslint.json") errors, $(jq '[.[].warningCount]|add//0' "$OUT/eslint.json") warnings |"
    jq -e . "$OUT/knip.json" >/dev/null 2>&1 && echo "| knip | out/knip.json | $(jq '.files|length' "$OUT/knip.json") unused files |"
    jq -e . "$OUT/madge.json" >/dev/null 2>&1 && echo "| madge | out/madge.json | $(jq 'length' "$OUT/madge.json") circular chains |"
  fi
  [ "$QUICK" != "1" ] && [ -f "$OUT/tsc.txt" ] && echo "| tsc | out/tsc.txt | $(grep -c 'error TS' "$OUT/tsc.txt" || true) type errors |"
  [ -f "$OUT/prisma.txt" ]  && echo "| prisma | out/prisma.txt | see file (validate / status / drift) |"
  [ -f "$OUT/db-checks.txt" ] && echo "| postgres | out/db-checks.txt | RLS / tenancy / money / FK index / roles |"
  echo "| hygiene | out/hygiene.txt | tracked secrets, public env, big blobs, suppressions, skipped tests |"
  echo "| stage status | out/stages.tsv | exact completed/skipped status and scanner exit codes |"
  echo
  if [ ${#SKIPPED[@]} -gt 0 ]; then
    echo "## Skipped"
    for s in "${SKIPPED[@]}"; do echo "- $s"; done
  fi
} > "$S"

if [ "${AUDIT_KEEP_HISTORY:-0}" = "1" ]; then
  # Opt-in because scanner evidence can be large and this machine is under disk pressure.
  mkdir -p "$OUT/history/$STAMP"
  cp "$OUT"/*.json "$OUT"/*.txt "$OUT"/*.md "$OUT"/*.jsonl "$OUT"/*.tsv "$OUT/history/$STAMP/" 2>/dev/null || true
fi

cat "$S"
printf '\nDone. Review audit/out/stages.tsv before treating any headline as evidence.\n'
