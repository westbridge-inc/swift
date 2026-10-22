#!/usr/bin/env python3
"""Validate rendered Compose JSON on stdin without contacting any service.

An authorized operator may pipe `docker compose ... config --format json` here.
Only fixed verdicts are printed: configuration may contain secret values.
This proves declared topology, never the existence of bytes or a live backup.
"""
import json
import posixpath
import sys


def validate(model):
    services = [model['services'][name] for name in ('api', 'worker')]
    environments = [service['environment'] for service in services]
    fields = ('STORAGE_DEPLOYMENT', 'STORAGE_PROVIDER', 'AWS_S3_BUCKET',
              'AWS_S3_ENDPOINT', 'AWS_REGION', 'AWS_S3_SSE', 'UPLOAD_DIR',
              'STORAGE_ALLOW_LOCAL', 'STORAGE_LOCAL_BACKUP_ACK')
    if any(environments[0].get(key) != environments[1].get(key) for key in fields):
        return False
    env = environments[0]
    if env.get('STORAGE_DEPLOYMENT') != 'managed':
        return False
    provider = env.get('STORAGE_PROVIDER')
    if provider in ('s3', 'r2'):
        bucket = env.get('AWS_S3_BUCKET')
        return isinstance(bucket, str) and bool(bucket.strip())
    if provider != 'local':
        return False
    if env.get('STORAGE_ALLOW_LOCAL') != '1' or env.get('STORAGE_LOCAL_BACKUP_ACK') != '1':
        return False
    root = env.get('UPLOAD_DIR', '')
    if not isinstance(root, str) or not root.startswith('/') or root.startswith('//') or root == '/' or posixpath.normpath(root) != root:
        return False
    mounts = []
    for service in services:
        candidates = [mount for mount in service.get('volumes', []) if mount.get('target') == root]
        if len(candidates) != 1:
            return False
        mount = candidates[0]
        if mount.get('type') != 'volume' or mount.get('read_only', False):
            return False
        mounts.append(mount.get('source'))
    if not mounts[0] or mounts[0] != mounts[1]:
        return False
    volume = model.get('volumes', {}).get(mounts[0], {})
    name = volume.get('name')
    return volume.get('external') is True and isinstance(name, str) and bool(name.strip())


def main():
    try:
        valid = validate(json.load(sys.stdin))
    except (ValueError, KeyError, TypeError, AttributeError):
        valid = False
    print('UPLOAD-STORAGE-OK (declared topology only)' if valid else 'UPLOAD-STORAGE-REFUSED')
    return 0 if valid else 1


if __name__ == '__main__':
    sys.exit(main())
