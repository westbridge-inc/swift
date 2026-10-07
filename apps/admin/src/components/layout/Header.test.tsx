import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Owner: "logging out of any account — the confirmation 'should we log you
// out', like every other app." The admin console's one sign-out control is the
// header's icon button. It asks first — [MC shell] in the page now, not a
// browser confirm (owner ruling, 6 Oct: no browser prompts) — and signs out on
// the server exactly once.
// ---------------------------------------------------------------------------

const nav = vi.hoisted(() => ({ replace: vi.fn() }));
const api = vi.hoisted(() => ({ logout: vi.fn<() => Promise<void>>() }));

vi.mock('next/navigation', () => ({ useRouter: () => nav, usePathname: () => '/vendors' }));
vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api')>()), logout: api.logout }));
vi.mock('./CommandPalette', () => ({ SearchLauncher: () => null }));

import { Header } from './Header';
import { ReasonDialogProvider } from '@/components/mc/ReasonDialog';

beforeEach(() => {
  api.logout.mockResolvedValue(undefined);
});

const renderHeader = () => render(<ReasonDialogProvider><Header /></ReasonDialogProvider>);
const signOutButton = () => screen.getByRole('button', { name: 'Sign out' });

describe('the admin console asks before it signs out', () => {
  it('asks in the page, and a declined ask ends nothing', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    renderHeader();
    const user = userEvent.setup();

    await user.click(signOutButton());
    const dialog = screen.getByRole('dialog', { name: 'Sign out of Swift Mission Control?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(api.logout).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('a confirmed ask signs out on the server once, even on a double click, then leaves', async () => {
    renderHeader();
    const user = userEvent.setup();
    await user.click(signOutButton());
    const confirmButton = within(screen.getByRole('dialog')).getByRole('button', { name: 'Sign out' });

    await act(async () => {
      confirmButton.click();
      confirmButton.click();
    });

    await waitFor(() => expect(nav.replace).toHaveBeenCalledExactlyOnceWith('/login'));
    expect(api.logout).toHaveBeenCalledTimes(1);
  });

  it('names the screen you are on', () => {
    renderHeader();
    expect(screen.getByText('Businesses')).toBeTruthy();
    expect(screen.getByText('Stores and service businesses')).toBeTruthy();
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
