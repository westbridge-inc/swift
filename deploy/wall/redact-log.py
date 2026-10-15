"""[TA-S0-003 · C1] A container log, redacted, for the results directory.

    docker compose … logs --no-color --tail 400 api | python3 -I deploy/wall/redact-log.py > api.log

deploy/wall/rehearsal.sh and journeys-on-copy.sh keep the copy's own logs
before the copy is removed, so a failed run can be diagnosed afterwards. The
API never logs a value on purpose; this is the second wall, for what a library,
a stack trace or a request line might still carry. Every match is dropped and
replaced by a marker; the rest of the line (what failed, which setting) stays:
  - key material: a PEM block, whole;
  - a value under a name that says secret, token, password (pass, passphrase),
    key, hash, credential or auth (the deploy tree's secret-name words), or
    cookie, DSN, salt, pepper, KEK, OTP, PIN or private: `NAME=value`,
    `NAME: value`, `"name":"value"`;
  - a value under a personal field: phone, mobile, MSISDN, any name, address,
    street, e-mail;
  - credentials inside a URL: everything between scheme:// and the LAST '@'
    before the host (a password may itself hold '@' or '/');
  - a Bearer/Basic authorization, a JWT, a long hex or high-entropy run;
  - phone numbers (E.164, Guyana's 592 form, NNN-NNNN and a bare 7-digit
    local number, accepting some false hits) and e-mail addresses.
Reads stdin, writes stdout, never fails on odd bytes.
"""
import re
import sys

SECRET_WORDS = (r'secret|token|passw(?:or)?d|passwd|passphrase|pass\b|pass_|pin\b|private|key|hash|credential|auth|cookie|dsn'
                r'|salt|pepper|kek|otp')
PERSONAL_WORDS = r'phone|mobile|msisdn|name|address|street|e-?mail'
VALUE = r'("(?:[^"\\]|\\.)*"|\'[^\']*\'|[^\s,;}\]&"\']+)'


def named(words: str) -> 're.Pattern[str]':
    """`NAME=value`, `NAME: value`, `"name":"value"` when the name holds one of the words."""
    return re.compile(r'(?i)(["\']?[A-Za-z0-9_.-]*(?:' + words + r')[A-Za-z0-9_.-]*["\']?\s*[:=]\s*)' + VALUE)


RULES = [
    # scheme://user:password@host -> scheme://[redacted]@host, up to the LAST '@' before a host.
    (re.compile(r'([A-Za-z][A-Za-z0-9+.-]*://)[^\s\'"]*@(?=[A-Za-z0-9.\[\]-]+(?::[0-9]+)?(?:[/\s\'"?#,;)]|$))'), r'\1[redacted]@'),
    # Before the name rule, which would otherwise take only the scheme word as the value.
    (re.compile(r'(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+'), r'\1 [redacted]'),
    (re.compile(r'\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*'), '[redacted]'),
    # "name":"value" / "name": value / name=value / name: value, when the name is secret-like or personal.
    (named(SECRET_WORDS), r'\1[redacted]'),
    (named(PERSONAL_WORDS), r'\1[redacted]'),
    (re.compile(r'\b[0-9A-Fa-f]{32,}\b'), '[redacted]'),
    (re.compile(r'(?<![A-Za-z0-9+/=])(?=[A-Za-z0-9+/]*[0-9])(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])'
                r'[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=])'), '[redacted]'),
    (re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}'), '[email]'),
    (re.compile(r'\+[1-9][0-9]{6,14}\b'), '[phone]'),
    (re.compile(r'\b592[-\s]?[0-9]{3}[-\s]?[0-9]{4}\b'), '[phone]'),
    (re.compile(r'(?<![0-9-])\b[0-9]{3}-[0-9]{4}\b(?!-)'), '[phone]'),
    (re.compile(r'\b[2-7][0-9]{6}\b'), '[phone]'),
]
PEM_START = re.compile(r'-----BEGIN [A-Z0-9 ]*-----')
PEM_END = re.compile(r'-----END [A-Z0-9 ]*-----')


def redact(line: str) -> str:
    for pattern, replacement in RULES:
        line = pattern.sub(replacement, line)
    return line


def main() -> int:
    in_pem = False
    for raw in sys.stdin.buffer:
        line = raw.decode('utf-8', 'replace').rstrip('\r\n')
        if in_pem or PEM_START.search(line):
            in_pem = not PEM_END.search(line)
            print('[redacted: key material]')
            continue
        print(redact(line))
    return 0


if __name__ == '__main__':
    sys.exit(main())
