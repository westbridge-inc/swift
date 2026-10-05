import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Owner: "logging out of any account — the confirmation 'should we log you
// out', like every other app." The admin console's one sign-out control is the
// header's icon button. It now asks first, through the console's own confirm
// (window.confirm, as every irreversible admin action does), and signs out on
// the server exactly once.
// ---------------------------------------------------------------------------

const nav = vi.hoisted(() => ({ replace: vi.fn() }));
const api = vi.hoisted(() => ({ logout: vi.fn<() => Promise<void>>() }));

vi.mock('next/navigation', () => ({ useRouter: () => nav }));
vi.mock('@/lib/api', () => ({ logout: api.logout }));
vi.mock('./GlobalSearch', () => ({ GlobalSearch: () => null }));

import { Header } from './Header';

beforeEach(() => {
  api.logout.mockResolvedValue(undefined);
});

const signOutButton = () => screen.getByRole('button', { name: 'Sign out' });

describe('the admin console asks before it signs out', () => {
  it('asks, and a declined ask ends nothing', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    render(<Header />);

    await userEvent.setup().click(signOutButton());

    expect(confirm).toHaveBeenCalledExactlyOnceWith('Sign out of Swift Admin on this browser?');
    expect(api.logout).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('a confirmed ask signs out on the server once, even on a double click, then leaves', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    render(<Header />);
    const button = signOutButton();

    await act(async () => {
      button.click();
      button.click();
    });

    expect(api.logout).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledExactlyOnceWith('/login');
  });
});

// A second sign-out control that skipped the ask would import logout() itself.
describe('the admin sign-out census', () => {
  const SRC = process.cwd().endsWith('apps/admin') ? join(process.cwd(), 'src') : join(process.cwd(), 'apps', 'admin', 'src');
  /** The only files that may reach logout(): where it is defined, and the one control that asks. */
  const MAY_END_A_SESSION = ['lib/api.ts', 'components/layout/Header.tsx'];

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
    });
  }

  function reachesLogout(path: string): boolean {
    const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, kind);
    let found = false;
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === 'logout')
        || (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'logout')
        || (ts.isFunctionDeclaration(node) && node.name?.text === 'logout')
      ) found = true;
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }

  it('only the header control (and its definition) reach logout()', () => {
    const reaching = sourceFiles(SRC)
      .filter(reachesLogout)
      .map((path) => relative(SRC, path).split(sep).join('/'))
      .sort();
    expect(reaching).toEqual([...MAY_END_A_SESSION].sort());
  });
});
