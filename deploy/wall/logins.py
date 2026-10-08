"""Login provisioning contract. No import-time database or credential I/O.

The coordinator supplies the catalogue and encrypted-store/connection ports.
The plan contains role names and decisions only. It never contains credentials,
SQL values, an implicit target, a rotation, or a privilege-repair operation.
"""
import argparse
import json
import re
import sys

LOGINS = ('swift_app_login', 'swift_system_login')
TARGET_FIELDS = ('cluster', 'database', 'migration', 'migrationOwner', 'ownershipDigest', 'aclDigest')
ZERO_FIELDS = ('disabledTables', 'unforcedTables', 'qrUnsafeGrants', 'obsoleteExecutable',
               'parentUpdateMissing', 'appendOnlyUnsafeGrants', 'defaultGrantCount',
               'groupUnsafeAttributes', 'groupUnexpectedParents')
ROLE_FLAGS = {'login': True, 'inherit': True, 'superuser': False, 'bypassrls': False,
              'createdb': False, 'createrole': False, 'replication': False}


class Refusal(RuntimeError):
    """Only constant, value-free reason codes cross the reporting boundary."""


def require(condition, code):
    if not condition:
        raise Refusal(code)


def _count(value):
    return type(value) is int and value >= 0


def _target(approved):
    require(type(approved) is dict, 'TARGET_INVALID')
    for field in TARGET_FIELDS:
        value = approved.get(field)
        require(type(value) is str and bool(value) and len(value) <= 256, 'TARGET_INVALID')
        if field.endswith('Digest'):
            require(re.fullmatch('[a-f0-9]{64}', value) is not None, 'TARGET_INVALID')


def _role(name, facts):
    require(type(facts) is dict, 'ROLE_CENSUS_UNKNOWN')
    for field, expected in ROLE_FLAGS.items():
        require(facts.get(field) is expected, 'ROLE_ATTRIBUTE_UNEXPECTED')
    parents = ['swift_app'] + (['swift_bypass_rls'] if name == LOGINS[1] else [])
    for field in ('parents', 'reachable'):
        actual = facts.get(field)
        require(type(actual) is list and all(type(item) is str for item in actual),
                'ROLE_MEMBERSHIP_UNKNOWN')
        require(sorted(actual) == sorted(parents), 'ROLE_MEMBERSHIP_UNEXPECTED')
    for field in ('adminMemberships', 'ownedObjects', 'directGrants', 'memberCount'):
        value = facts.get(field)
        require(_count(value) and value == 0, 'ROLE_AUTHORITY_UNEXPECTED')
    require(facts.get('settings') == [], 'ROLE_SETTINGS_UNEXPECTED')


def plan(catalogue, approved):
    """Fail closed before writing anything; existing roles are never repaired."""
    _target(approved)
    require(type(catalogue) is dict, 'CENSUS_UNKNOWN')
    for field in TARGET_FIELDS:
        require(catalogue.get(field) == approved[field], 'TARGET_OR_CATALOGUE_CHANGED')
    require(catalogue.get('ownerIsPrivileged') is True, 'MIGRATION_OWNER_UNSAFE')
    require(catalogue.get('qrSchemaPresent') is True, 'PRIVATE_SCHEMA_MISSING')
    require(_count(catalogue.get('tenantTables')) and catalogue['tenantTables'] > 0,
            'TENANT_CENSUS_UNKNOWN')
    for field in ZERO_FIELDS:
        value = catalogue.get(field)
        require(_count(value) and value == 0, 'CATALOGUE_CONTRACT_FAILED')
    roles = catalogue.get('roles')
    require(type(roles) is dict and set(roles).issubset(LOGINS), 'ROLE_CENSUS_UNKNOWN')
    for name, facts in roles.items():
        _role(name, facts)
    return {'create': [name for name in LOGINS if name not in roles],
            'verify': [name for name in LOGINS if name in roles]}


def _stored(ports, approved, decisions):
    """Inspect BOTH identities before the first state change."""
    saved = {}
    for name in LOGINS:
        secret = ports.read(name)
        published = ports.read(name + ':published')
        require(secret is not None or name in decisions['create'], 'EXISTING_LOGIN_WITHOUT_JOURNAL')
        require(published is None or secret == published, 'PUBLISHED_CREDENTIAL_CONFLICT')
        if secret is not None:
            require(type(secret) is dict and type(secret.get('credential')) is str
                    and bool(secret['credential']), 'CREDENTIAL_JOURNAL_INVALID')
            require(secret.get('target') == approved, 'CREDENTIAL_TARGET_CHANGED')
        saved[name] = secret
    return saved


def _connections(ports, saved):
    for name in LOGINS:
        facts = ports.connect(name, saved[name])
        require(type(facts) is dict and facts.get('sessionUser') == name
                and facts.get('currentUser') == name, 'CONNECTION_IDENTITY_MISMATCH')
        require(facts.get('requestWallEnforced') is (name == LOGINS[0]), 'REQUEST_WALL_INVALID')
        require(facts.get('systemCapabilityMember') is (name == LOGINS[1]), 'SYSTEM_POOL_INVALID')


def apply(ports, approved):
    """Recover interrupted creation/publication using durable encrypted material.

    Port contract: prepare is create-exclusive, durable and encrypted before it
    returns; create is one SQL transaction with no other grants; connect opens
    a NEW connection with that credential (never SET ROLE); publish is atomic
    and retains the prepared journal. The concrete adapter must serialize this
    sequence. Exceptions are redacted, including a failed connection's URL.
    """
    try:
        decisions = plan(ports.census(), approved)
        saved = _stored(ports, approved, decisions)
        # Prepare both recoverable credentials before either login is created.
        for name in LOGINS:
            if saved[name] is None:
                saved[name] = ports.prepare(name)
                require(type(saved[name]) is dict and saved[name].get('target') == approved
                        and type(saved[name].get('credential')) is str and bool(saved[name]['credential']),
                        'PREPARED_CREDENTIAL_INVALID')
        for name in decisions['create']:
            ports.create(name, saved[name])
        require(not plan(ports.census(), approved)['create'], 'PROVISION_INCOMPLETE')
        _connections(ports, saved)
        # No credential is published until BOTH separate logins have attested.
        for name in LOGINS:
            ports.publish(name, saved[name])
        require(not plan(ports.census(), approved)['create'], 'POST_PUBLICATION_DRIFT')
        return {'status': 'verified', 'logins': len(LOGINS), 'separateConnections': len(LOGINS)}
    except Refusal:
        raise
    except Exception:
        raise Refusal('PROVISION_INTERRUPTED_RETRY_WITH_SAME_JOURNAL') from None


def verify(ports, approved):
    """A read-only repeat check never creates a role, secret or replacement."""
    try:
        decisions = plan(ports.census(), approved)
        require(not decisions['create'], 'LOGINS_MISSING')
        saved = _stored(ports, approved, decisions)
        for name in LOGINS:
            require(ports.read(name + ':published') == saved[name], 'PUBLICATION_INCOMPLETE')
        _connections(ports, saved)
        return {'status': 'verified', 'logins': len(LOGINS), 'separateConnections': len(LOGINS)}
    except Refusal:
        raise
    except Exception:
        raise Refusal('VERIFY_FAILED') from None


def main():
    parser = argparse.ArgumentParser(description='Offline role plan; no database or secret-store access.')
    parser.add_argument('command', choices=['plan'])
    parser.add_argument('--catalogue-file', required=True)
    parser.add_argument('--approved-target-file', required=True)
    args = parser.parse_args()
    try:
        with open(args.catalogue_file, encoding='utf-8') as file:
            catalogue = json.load(file)
        with open(args.approved_target_file, encoding='utf-8') as file:
            approved = json.load(file)
        print(json.dumps({'status': 'plan_only', **plan(catalogue, approved)}, sort_keys=True))
        return 0
    except Refusal as error:
        print(json.dumps({'status': 'hold', 'reason': str(error)}))
        return 1
    except Exception:
        print(json.dumps({'status': 'hold', 'reason': 'INPUT_UNREADABLE'}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
