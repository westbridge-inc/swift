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
    // [UXR-W-015] This used to also require an inner `<View style={{ flexGrow: 1 }}>`
    // wrapper, whose job was to push the funnel links to the bottom of tall
    // screens. That gap WAS the defect the founder's "we can do better" pass
    // caught: three unlabelled links floating in ~300px of nothing read as
    // debug shortcuts. They now follow the content in a titled card, so the
    // wrapper is gone on purpose. The reachability guarantee it stood for is
    // the ScrollView's own flexGrow plus the bottom-safe padding — both still
    // asserted above, and neither depends on the inner wrapper.
    expect(src).not.toContain("<View style={{ flexGrow: 1, justifyContent: 'center' }}>");
  });

  it('opens on the brand masthead — first open must not be a plain white page', () => {
    // The one screen that introduces the product wears Swift's own face:
    // the gradient masthead under the kit's 28dp curve, with the mark
    // reversed for the red. Regressing this to a bare Screen is the exact
    // "clean-minimal reads as basic" failure this pass existed to fix.
    expect(src).toMatch(/<GradientMasthead/);
    expect(src).toMatch(/<SwiftMark[\s\S]*?tint=\{color\.white\}/);
    expect(src).toMatch(/tone="onBrand"/);
    // Each vertical keeps its own identity colour off the F-263 ramp rather
    // than three identical brand tints.
    expect(src).toMatch(/VERTICAL_TINT\[o\.tint\]/);
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
