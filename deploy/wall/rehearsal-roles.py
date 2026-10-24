"""[TA-S0-003 · C1] Filter `pg_dumpall --roles-only --no-role-passwords` to the
named group roles, for the rehearsal copy (deploy/wall/rehearsal.sh).

    pg_dumpall --roles-only --no-role-passwords | python3 -I rehearsal-roles.py swift_app swift_bypass_rls ... [--optional NAME ...]

A group named after --optional is kept the same way when the dump has it and
is not required when it does not (swift_owner_wall exists only once the owner
wall's migrations ran: its policies name it, so a copy without it would error
on every owner-walled table).

Kept: CREATE ROLE / ALTER ROLE for a named group, and GRANT lines where both
the granted role and the member are named groups. Dropped: every other role
(the owner, which the copy's cluster already has; any runtime login) and the
dump's SET lines. Any other kind of line is refused: an unknown statement is
never passed through. Exit 1 with a constant code; nothing is echoed.
"""
import re
import sys


def main(argv):
    required, optional, target = [], [], None
    for arg in argv:
        if arg == '--optional':
            target = optional
            continue
        (required if target is None else target).append(arg)
    if not required or ('--optional' in argv and not optional):
        print('ROLE_FILTER_NEEDS_GROUPS', file=sys.stderr)
        return 1
    allowed = set(required) | set(optional)
    kept, created = [], set()
    for raw in sys.stdin:
        line = raw.rstrip('\n')
        if not line or line.startswith('--'):
            continue
        if re.fullmatch(r"SET [a-z_]+ = [^;]*;", line):
            continue
        role = re.fullmatch(r'(CREATE|ALTER) ROLE ([a-z_][a-z0-9_]*)( WITH [A-Z ]+)?;', line)
        if role:
            if role.group(2) in allowed:
                kept.append(line)
                if role.group(1) == 'CREATE':
                    created.add(role.group(2))
            continue
        grant = re.fullmatch(r'GRANT ([a-z_][a-z0-9_]*) TO ([a-z_][a-z0-9_]*)'
                             r'( WITH (INHERIT|ADMIN|SET) (TRUE|FALSE)(, (INHERIT|ADMIN|SET) (TRUE|FALSE))*)?'
                             r'( GRANTED BY [a-z_][a-z0-9_]*)?;', line)
        if grant:
            if grant.group(1) in allowed and grant.group(2) in allowed:
                kept.append(line)
            continue
        print('ROLE_DUMP_UNEXPECTED_LINE', file=sys.stderr)
        return 1
    if not set(required) <= created:
        print('ROLE_DUMP_MISSING_GROUP', file=sys.stderr)
        return 1
    print('\n'.join(kept))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
