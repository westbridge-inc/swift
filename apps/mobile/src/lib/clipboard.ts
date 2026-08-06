/**
 * Copy text to the OS clipboard.
 *
 * Swift has no clipboard dependency yet, so this leans on React Native's core
 * `Clipboard`. It's deprecated (moved to `@react-native-clipboard/clipboard`)
 * but still present through RN 0.85, and accessed here through a guarded, lazy
 * require so a build without the native module degrades to a no-op instead of
 * crashing at call time — the same native-module lesson as `lib/payLink`
 * (see reference_swift_native_module_crash). The Swift Number is always on
 * screen and selectable, so a failed copy is never a dead end.
 *
 * Returns whether the copy actually happened.
 */
export function copyText(text: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rn = require('react-native') as { Clipboard?: { setString(value: string): void } };
    if (rn.Clipboard?.setString) {
      rn.Clipboard.setString(text);
      return true;
    }
  } catch {
    // Clipboard extracted from core / native module absent — non-fatal.
  }
  return false;
}
