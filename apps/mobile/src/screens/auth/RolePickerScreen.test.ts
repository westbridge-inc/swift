import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The mobile Vitest harness is pure Node and has no RN renderer. Keep a
// source-level contract, matching vendorPreviewReadonly.test.ts, around the
// first-open guarantees that are otherwise easy to regress during a UI pass.
const src = readFileSync(join(process.cwd(), 'src/screens/auth/RolePickerScreen.tsx'), 'utf8');

describe('RolePickerScreen first-open contract', () => {
  it('keeps every action reachable with adaptive scrolling and bottom-safe padding', () => {
    expect(src).toMatch(/import \{ Pressable, ScrollView, View \} from 'react-native'/);
    expect(src).toMatch(/const insets = useSafeAreaInsets\(\)/);
    expect(src).toMatch(/<ScrollView[\s\S]*?contentContainerStyle=\{\{[\s\S]*?flexGrow: 1/);
    expect(src).toMatch(/paddingBottom: space\['2xl'\] \+ insets\.bottom/);
    expect(src).toContain('<View style={{ flexGrow: 1 }}>');
    expect(src).not.toContain("<View style={{ flexGrow: 1, justifyContent: 'center' }}>");
  });

  it('exposes button semantics for the trio, sign-in, and all lower actions', () => {
    const quietRow = src.slice(src.indexOf('function QuietRow'), src.indexOf('export function RolePickerScreen'));
    const roleCard = src.slice(src.indexOf('<PressableScale'), src.indexOf('</PressableScale>'));

    expect(quietRow).toMatch(/accessibilityRole="button"/);
    expect(quietRow).toMatch(/accessibilityLabel=\{label\}/);
    expect(quietRow).toMatch(/accessibilityHint=\{hint\}/);
    expect(quietRow).toMatch(/minHeight: 44/);
    expect(quietRow).toMatch(/maxWidth: '100%'/);
    expect(quietRow).toMatch(/flexShrink: 1/);
    expect(quietRow).not.toMatch(/hitSlop/);

    expect(roleCard).toMatch(/accessibilityRole="button"/);
    expect(roleCard).toMatch(/accessibilityLabel=\{`\$\{o\.title\}\. \$\{o\.sub\}`\}/);
    expect(roleCard).toMatch(/accessibilityHint=\{o\.hint\}/);

    expect(src).toMatch(/accessibilityLabel="Already have an account\? Sign in"/);
    expect(src).toMatch(/accessibilityHint="Open phone sign in"/);
    expect(src).toMatch(/minHeight: 44,[\s\S]*?accessibilityLabel="Already have an account\? Sign in"/);
    expect(src).toMatch(/maxWidth: '100%',[\s\S]*?textAlign: 'center'/);
    expect(src.match(/<QuietRow/g) ?? []).toHaveLength(3);
  });
});
