"""Offline tests. The fake ports cannot connect to a service or read secrets."""
import copy
import importlib.util
from pathlib import Path
import unittest

PATH = Path(__file__).resolve().parents[1] / 'wall' / 'logins.py'
spec = importlib.util.spec_from_file_location('wall_logins', PATH)
wall = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wall)


def catalogue():
    return {
        'cluster': 'fixture-cluster', 'database': 'fixture_copy', 'migration': 'fixture_head',
        'migrationOwner': 'fixture_owner', 'ownerIsPrivileged': True,
        'tenantTables': 2, 'disabledTables': 0, 'unforcedTables': 0,
        'qrSchemaPresent': True, 'qrUnsafeGrants': 0, 'obsoleteExecutable': 0,
        'parentUpdateMissing': 0, 'appendOnlyUnsafeGrants': 0,
        'defaultGrantCount': 0, 'groupUnsafeAttributes': 0, 'groupUnexpectedParents': 0,
        'ownershipDigest': 'a' * 64, 'aclDigest': 'b' * 64,
        'roles': {},
    }


def approved():
    return {'cluster': 'fixture-cluster', 'database': 'fixture_copy', 'migration': 'fixture_head',
            'migrationOwner': 'fixture_owner', 'ownershipDigest': 'a' * 64, 'aclDigest': 'b' * 64}


def role(name):
    parents = ['swift_app'] + (['swift_bypass_rls'] if name == 'swift_system_login' else [])
    return {'login': True, 'inherit': True, 'superuser': False, 'bypassrls': False,
            'createdb': False, 'createrole': False, 'replication': False,
            'parents': parents, 'reachable': parents, 'adminMemberships': 0,
            'ownedObjects': 0, 'directGrants': 0, 'settings': [], 'memberCount': 0}


class Ports:
    def __init__(self):
        self.cat = catalogue()
        self.secrets = {}
        self.passwords = {}
        self.calls = []
        self.fail = None

    def census(self):
        self.calls.append('census')
        return copy.deepcopy(self.cat)

    def read(self, name):
        return self.secrets.get(name)

    def prepare(self, name):
        self.calls.append('prepare:' + name)
        self.secrets[name] = {'credential': 'fixture-' + name, 'target': approved()}
        return self.secrets[name]

    def create(self, name, secret):
        self.calls.append('create:' + name)
        self.cat['roles'][name] = role(name)
        self.passwords[name] = secret['credential']
        if self.fail == 'after-create':
            self.fail = None
            raise RuntimeError('synthetic interruption')

    def connect(self, name, secret):
        self.calls.append('connect:' + name)
        if self.passwords.get(name) != secret['credential']:
            raise RuntimeError('synthetic private connection error')
        return {'sessionUser': name, 'currentUser': name,
                'requestWallEnforced': name == 'swift_app_login',
                'systemCapabilityMember': name == 'swift_system_login'}

    def publish(self, name, secret):
        self.calls.append('publish:' + name)
        self.secrets[name + ':published'] = copy.deepcopy(secret)
        if self.fail == 'after-publish':
            self.fail = None
            raise RuntimeError('synthetic interruption')


class LoginPlanTests(unittest.TestCase):
    def test_empty_catalogue_plans_only_the_two_named_logins(self):
        plan = wall.plan(catalogue(), approved())
        self.assertEqual(plan['create'], ['swift_app_login', 'swift_system_login'])
        self.assertEqual(plan['verify'], [])
        self.assertNotIn('PASSWORD', str(plan))

    def test_exact_roles_are_verified_without_repair(self):
        cat = catalogue()
        cat['roles'] = {name: role(name) for name in wall.LOGINS}
        self.assertEqual(wall.plan(cat, approved())['create'], [])
        self.assertEqual(wall.plan(cat, approved())['verify'], list(wall.LOGINS))

    def test_every_invalid_role_attribute_is_refused(self):
        for name in wall.LOGINS:
            for key in ['login', 'inherit', 'superuser', 'bypassrls', 'createdb', 'createrole', 'replication']:
                with self.subTest(name=name, key=key):
                    cat = catalogue()
                    cat['roles'][name] = role(name)
                    cat['roles'][name][key] = not cat['roles'][name][key]
                    with self.assertRaises(wall.Refusal):
                        wall.plan(cat, approved())

    def test_extra_missing_transitive_admin_and_reverse_memberships_refuse(self):
        for key, value in [('parents', []), ('parents', ['swift_app', 'fixture_owner']),
                           ('reachable', ['swift_app', 'fixture_owner']), ('adminMemberships', 1),
                           ('memberCount', 1), ('ownedObjects', 1), ('directGrants', 1),
                           ('settings', ['role=fixture_owner'])]:
            with self.subTest(key=key, value=value):
                cat = catalogue()
                cat['roles']['swift_app_login'] = role('swift_app_login')
                cat['roles']['swift_app_login'][key] = value
                with self.assertRaises(wall.Refusal):
                    wall.plan(cat, approved())

    def test_every_target_and_acl_invariant_is_required(self):
        invalid = {'cluster': 'other', 'database': 'other', 'migration': 'other',
                   'migrationOwner': 'other', 'ownerIsPrivileged': False, 'tenantTables': 0,
                   'disabledTables': 1, 'unforcedTables': 1, 'qrSchemaPresent': False,
                   'qrUnsafeGrants': 1, 'obsoleteExecutable': 1, 'parentUpdateMissing': 1,
                   'appendOnlyUnsafeGrants': 1, 'defaultGrantCount': 1,
                   'groupUnsafeAttributes': 1, 'groupUnexpectedParents': 1,
                   'ownershipDigest': 'c' * 64, 'aclDigest': 'c' * 64}
        for key, value in invalid.items():
            with self.subTest(key=key):
                cat = catalogue()
                cat[key] = value
                with self.assertRaises(wall.Refusal):
                    wall.plan(cat, approved())

    def test_unknown_or_malformed_census_never_passes(self):
        for key in catalogue():
            cat = catalogue()
            del cat[key]
            with self.subTest(key=key), self.assertRaises(wall.Refusal):
                wall.plan(cat, approved())
        for value in [-1, True, '0', None, 0.5]:
            cat = catalogue()
            cat['disabledTables'] = value
            with self.subTest(value=value), self.assertRaises(wall.Refusal):
                wall.plan(cat, approved())

    def test_apply_persists_before_role_and_attests_before_publish(self):
        p = Ports()
        report = wall.apply(p, approved())
        self.assertEqual(report['status'], 'verified')
        for name in wall.LOGINS:
            self.assertLess(p.calls.index('prepare:' + name), p.calls.index('create:' + name))
            self.assertLess(p.calls.index('connect:' + name), p.calls.index('publish:' + name))
        self.assertNotIn('credential', str(report))

    def test_rerun_and_interrupted_publication_retain_credentials(self):
        for interruption in [None, 'after-create', 'after-publish']:
            with self.subTest(interruption=interruption):
                p = Ports()
                p.fail = interruption
                if interruption:
                    with self.assertRaises(wall.Refusal):
                        wall.apply(p, approved())
                else:
                    wall.apply(p, approved())
                prior = copy.deepcopy(p.passwords)
                wall.apply(p, approved())
                wall.apply(p, approved())
                self.assertTrue(all(p.passwords[k] == v for k, v in prior.items()))
                for name in wall.LOGINS:
                    self.assertEqual(p.calls.count('prepare:' + name), 1)
                    self.assertEqual(p.calls.count('create:' + name), 1)

    def test_existing_login_without_store_material_refuses_without_writes(self):
        p = Ports()
        p.cat['roles']['swift_app_login'] = role('swift_app_login')
        with self.assertRaises(wall.Refusal):
            wall.apply(p, approved())
        self.assertEqual(p.calls, ['census'])

    def test_wrong_target_secret_or_changed_owner_refuses_before_writes(self):
        for field in approved():
            p = Ports()
            secret = p.prepare('swift_app_login')
            secret['target'][field] = 'wrong'
            p.calls.clear()
            with self.subTest(field=field), self.assertRaises(wall.Refusal):
                wall.apply(p, approved())
            self.assertEqual(p.calls, ['census'])

    def test_both_secrets_are_prevalidated_before_any_mutation(self):
        p = Ports()
        p.cat['roles']['swift_system_login'] = role('swift_system_login')
        with self.assertRaises(wall.Refusal):
            wall.apply(p, approved())
        self.assertFalse(any(c.startswith(('prepare:', 'create:', 'publish:')) for c in p.calls))

    def test_swapped_connection_or_unknown_posture_never_publishes(self):
        for result in [{}, {'sessionUser': 'swift_system_login', 'currentUser': 'swift_system_login'},
                       {'sessionUser': 'swift_app_login', 'currentUser': 'swift_app_login',
                        'requestWallEnforced': False, 'systemCapabilityMember': False}]:
            p = Ports()
            p.connect = lambda *args: result
            with self.subTest(result=result), self.assertRaises(wall.Refusal):
                wall.apply(p, approved())
            self.assertFalse(any(c.startswith('publish:') for c in p.calls))

    def test_exception_and_plan_outputs_do_not_echo_input(self):
        marker = 'PRIVATE_FIXTURE_MUST_NOT_ESCAPE'
        cat = catalogue()
        cat['cluster'] = marker
        with self.assertRaises(wall.Refusal) as caught:
            wall.plan(cat, approved())
        self.assertNotIn(marker, str(caught.exception))
        p = Ports()
        def fail(*args):
            raise RuntimeError(marker)
        p.connect = fail
        with self.assertRaises(wall.Refusal) as caught:
            wall.apply(p, approved())
        self.assertNotIn(marker, str(caught.exception))


if __name__ == '__main__':
    unittest.main()
