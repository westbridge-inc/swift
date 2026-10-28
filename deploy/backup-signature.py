#!/usr/bin/env python3
"""[SEC-BACKUP F2] Sign a backup on the host; verify it before any restore.

A dump's signature travels beside it as <object>.sig: a short manifest (the
object's name, size and SHA-256, the plain dump's SHA-256 when the object is
the encrypted copy) followed by an SSH signature over exactly those manifest
bytes, made with the host's ed25519 backup signing key (namespace
"swift-backup"). The signing key lives in the backup store only
(/etc/credstore.encrypted/swift-backup, never materialized for the
containers). Restores verify against an allowed-signers file of PUBLIC keys
(default /etc/swift/backup-allowed-signers): whoever can write to the backup
bucket cannot make a dump that verifies.

    backup-signature.py sign   --key KEY --object FILE --out SIG [--plain-sha256 HEX] [--created STAMP]
    backup-signature.py verify --allowed-signers FILE --sig SIG --name OBJECT_NAME
                               [--object FILE] [--plain FILE] [--print]
    backup-signature.py check-trust --allowed-signers FILE

verify checks the signature and the object name always; --object also checks
the object's size and SHA-256, --plain the plain dump's SHA-256 (the manifest's
plain-sha256, or sha256 when the object itself is the plain dump). --print
writes the verified bundle to stdout. Exit 0 verified; 3 refused (unsigned
shape, wrong key, tampered, renamed); 4 the allowed-signers file is unusable;
2 usage. Run with python3 -I. Uses ssh-keygen for the cryptography.
"""
import argparse
import hashlib
import os
import re
import stat
import subprocess
import sys
import tempfile

NAMESPACE = "swift-backup"
PRINCIPAL = "swift-backup"
HEADER = "swift-backup-signature 1"
BEGIN = "-----BEGIN SSH SIGNATURE-----"
END = "-----END SSH SIGNATURE-----"
MAX_BUNDLE = 16384
FIELDS = [
    ("object", re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}"), True),
    ("bytes", re.compile(r"[0-9]{1,15}"), True),
    ("sha256", re.compile(r"[0-9a-f]{64}"), True),
    ("plain-sha256", re.compile(r"[0-9a-f]{64}"), False),
    ("created", re.compile(r"[0-9]{8}T[0-9]{6}Z"), True),
]


class Refused(Exception):
    pass


class Untrusted(Exception):
    pass


def sha256_of(path):
    h = hashlib.sha256()
    size = 0
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size


def parse(bundle):
    """(manifest bytes, fields, armored signature) or Refused."""
    if len(bundle) > MAX_BUNDLE:
        raise Refused("the signature file is too large to be a backup signature")
    try:
        text = bundle.decode("ascii")
    except UnicodeDecodeError:
        raise Refused("the signature file is not a backup signature")
    at = text.find(BEGIN + "\n")
    if at <= 0 or not text.rstrip("\n").endswith(END):
        raise Refused("the signature file carries no SSH signature")
    manifest, armor = text[:at], text[at:]
    lines = manifest.split("\n")
    if lines[-1] != "" or lines[0] != HEADER:
        raise Refused("the signature file is not a version 1 backup signature")
    fields = {}
    expected = iter(FIELDS)
    for line in lines[1:-1]:
        key, sep, value = line.partition(" ")
        for name, shape, required in expected:
            if name == key:
                break
            if required:
                raise Refused(f"the backup signature lacks its {name} line")
        else:
            raise Refused("the backup signature has an unexpected line")
        if not sep or not shape.fullmatch(value):
            raise Refused(f"the backup signature's {key} line is malformed")
        fields[key] = value
    for name, _shape, required in expected:
        if required:
            raise Refused(f"the backup signature lacks its {name} line")
    return manifest.encode("ascii"), fields, armor


def check_trust(path):
    try:
        st = os.stat(path)
    except OSError:
        raise Untrusted(f"the allowed-signers file {path} does not exist: install the backup signing PUBLIC key there (sudo swift-secrets backup init, or the owner's copy)")
    if not stat.S_ISREG(st.st_mode):
        raise Untrusted(f"the allowed-signers file {path} is not a regular file")
    if st.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise Untrusted(f"the allowed-signers file {path} is writable by others; refusing to trust it (chmod 644)")
    if st.st_uid not in (0, os.getuid()):
        raise Untrusted(f"the allowed-signers file {path} is owned by another user; refusing to trust it")
    with open(path) as f:
        keys = [l for l in f if l.startswith(PRINCIPAL + " ")]
    if not keys:
        raise Untrusted(f"the allowed-signers file {path} names no {PRINCIPAL} key")


def ssh_verify(allowed, manifest, armor):
    with tempfile.TemporaryDirectory() as tmp:
        sig = os.path.join(tmp, "manifest.sig")
        with open(sig, "w") as f:
            f.write(armor)
        r = subprocess.run(
            ["ssh-keygen", "-Y", "verify", "-f", allowed, "-I", PRINCIPAL, "-n", NAMESPACE, "-s", sig],
            input=manifest, capture_output=True,
        )
    if r.returncode != 0:
        raise Refused("the backup signature does not verify against the trusted backup signing key (wrong key, or the manifest was changed)")


def cmd_sign(a):
    digest, size = sha256_of(a.object)
    name = os.path.basename(a.object)
    if a.plain_sha256 is not None and not re.fullmatch(r"[0-9a-f]{64}", a.plain_sha256):
        raise SystemExit("backup-signature: --plain-sha256 must be 64 lowercase hex characters")
    lines = [HEADER, f"object {name}", f"bytes {size}", f"sha256 {digest}"]
    if a.plain_sha256:
        lines.append(f"plain-sha256 {a.plain_sha256}")
    lines.append(f"created {a.created}")
    manifest = ("\n".join(lines) + "\n").encode("ascii")
    parse(manifest + (BEGIN + "\nx\n" + END + "\n").encode())  # the shape restores accept
    r = subprocess.run(["ssh-keygen", "-Y", "sign", "-f", a.key, "-n", NAMESPACE], input=manifest, capture_output=True)
    if r.returncode != 0 or BEGIN.encode() not in r.stdout:
        raise SystemExit("backup-signature: ssh-keygen could not sign the manifest")
    tmp = a.out + ".partial"
    with open(tmp, "wb") as f:
        f.write(manifest + r.stdout)
    os.chmod(tmp, 0o600)
    os.replace(tmp, a.out)
    print(f"signed {name} (sha256 {digest})")


def cmd_verify(a):
    with open(a.sig, "rb") as f:
        bundle = f.read(MAX_BUNDLE + 1)
    manifest, fields, armor = parse(bundle)
    if fields["object"] != a.name:
        raise Refused(f"the signature is for {fields['object']}, not {a.name}: a signed dump cannot be renamed into another")
    check_trust(a.allowed_signers)
    ssh_verify(a.allowed_signers, manifest, armor)
    if a.object:
        digest, size = sha256_of(a.object)
        if size != int(fields["bytes"]) or digest != fields["sha256"]:
            raise Refused("the object's bytes differ from what was signed (tampered or truncated)")
    if a.plain:
        want = fields.get("plain-sha256", fields["sha256"])
        digest, _size = sha256_of(a.plain)
        if digest != want:
            raise Refused("the dump's bytes differ from what was signed (tampered, or not this backup)")
    if a.print:
        sys.stdout.buffer.write(bundle)
        sys.stdout.flush()
    print(f"signature OK: {a.name} was signed by the trusted backup signing key", file=sys.stderr)


def main():
    p = argparse.ArgumentParser(prog="backup-signature.py")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sign")
    s.add_argument("--key", required=True)
    s.add_argument("--object", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--plain-sha256")
    s.add_argument("--created", required=True)
    v = sub.add_parser("verify")
    v.add_argument("--allowed-signers", required=True)
    v.add_argument("--sig", required=True)
    v.add_argument("--name", required=True)
    v.add_argument("--object")
    v.add_argument("--plain")
    v.add_argument("--print", action="store_true")
    t = sub.add_parser("check-trust")
    t.add_argument("--allowed-signers", required=True)
    a = p.parse_args()
    try:
        if a.cmd == "sign":
            if not re.fullmatch(r"[0-9]{8}T[0-9]{6}Z", a.created):
                raise SystemExit("backup-signature: --created must be a UTC stamp like 20261028T091500Z")
            cmd_sign(a)
        elif a.cmd == "verify":
            cmd_verify(a)
        else:
            check_trust(a.allowed_signers)
    except Refused as e:
        print(f"backup-signature: REFUSED: {e}", file=sys.stderr)
        sys.exit(3)
    except Untrusted as e:
        print(f"backup-signature: {e}", file=sys.stderr)
        sys.exit(4)


if __name__ == "__main__":
    main()
