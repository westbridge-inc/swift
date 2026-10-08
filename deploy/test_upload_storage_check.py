"""Offline contract tests; no daemon, environment file, or provider access."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest


SCRIPT = Path(__file__).with_name('check-upload-storage.py')


def model():
    env = {'STORAGE_DEPLOYMENT': 'managed', 'STORAGE_PROVIDER': 's3',
           'AWS_S3_BUCKET': 'synthetic-private-bucket',
           'AWS_S3_ENDPOINT': 'https://objects.example.invalid', 'AWS_REGION': 'auto'}
    return {'services': {name: {'environment': dict(env)} for name in ('api', 'worker')}}


def local_model():
    result = model()
    for service in result['services'].values():
        service['environment'].update(STORAGE_PROVIDER='local', STORAGE_ALLOW_LOCAL='1',
                                      STORAGE_LOCAL_BACKUP_ACK='1', UPLOAD_DIR='/srv/swift/uploads')
        service['volumes'] = [{'type': 'volume', 'source': 'private-uploads', 'target': '/srv/swift/uploads'}]
    result['volumes'] = {'private-uploads': {'external': True, 'name': 'synthetic-existing-volume'}}
    return result


class UploadStorageCheck(unittest.TestCase):
    def check_model(self, config, good):
        result = subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps(config),
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0 if good else 1, result.stderr)
        self.assertIn('UPLOAD-STORAGE-OK' if good else 'UPLOAD-STORAGE-REFUSED', result.stdout)
        self.assertNotIn('synthetic-', result.stdout + result.stderr)

    def test_shared_bucket(self):
        self.check_model(model(), True)

    def test_external_shared_volume(self):
        self.check_model(local_model(), True)

    def test_bucket_region_endpoint_and_provider_must_match(self):
        for key in ('AWS_S3_BUCKET', 'AWS_S3_ENDPOINT', 'AWS_REGION', 'STORAGE_PROVIDER'):
            with self.subTest(field=key):
                config = model()
                config['services']['worker']['environment'][key] = 'synthetic-other'
                self.check_model(config, False)

    def test_missing_bucket_or_worker_refuses(self):
        config = model()
        for service in config['services'].values():
            service['environment']['AWS_S3_BUCKET'] = ''
        self.check_model(config, False)
        for service in config['services'].values():
            service['environment']['AWS_S3_BUCKET'] = None
        self.check_model(config, False)
        config = model()
        del config['services']['worker']
        self.check_model(config, False)

    def test_local_ephemeral_or_split_or_readonly_mount_refuses(self):
        for change in ('missing', 'different', 'readonly', 'bind', 'root', 'nonexternal', 'unnamed'):
            with self.subTest(change=change):
                config = local_model()
                worker = config['services']['worker']
                mount = worker['volumes'][0]
                if change == 'missing': worker['volumes'] = []
                elif change == 'different': mount['source'] = 'other-volume'
                elif change == 'readonly': mount['read_only'] = True
                elif change == 'bind': mount['type'] = 'bind'
                elif change == 'root': worker['environment']['UPLOAD_DIR'] = '/other/root'
                elif change == 'nonexternal': config['volumes']['private-uploads']['external'] = False
                elif change == 'unnamed': del config['volumes']['private-uploads']['name']
                self.check_model(config, False)

    def test_local_acknowledgements_are_required(self):
        for root in ('relative/root', '/', '/srv/../uploads', '//srv/uploads'):
            config = local_model()
            for service in config['services'].values():
                service['environment']['UPLOAD_DIR'] = root
                service['volumes'][0]['target'] = root
            self.check_model(config, False)
        for field in ('STORAGE_ALLOW_LOCAL', 'STORAGE_LOCAL_BACKUP_ACK'):
            config = local_model()
            config['services']['api']['environment'][field] = '0'
            self.check_model(config, False)

    def test_result_does_not_echo_untrusted_configuration(self):
        config = copy.deepcopy(model())
        config['services']['worker']['environment']['AWS_S3_BUCKET'] = 'synthetic-credential-bearing-value'
        self.check_model(config, False)


if __name__ == '__main__':
    unittest.main()
