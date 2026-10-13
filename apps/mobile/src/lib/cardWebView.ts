import type { ComponentType } from 'react';
import { TurboModuleRegistry } from 'react-native';
import type { WebViewProps } from 'react-native-webview';

// react-native-webview is a NATIVE module, first in the binaries built after it was added
// (store build 11). Store builds 9 and 10 do not have it, and this JavaScript reaches them
// too (over-the-air updates share runtime 1.0.0). Its JavaScript asks for the native module
// the moment it loads (TurboModuleRegistry.getEnforcing), so an import at the top of a file
// would crash those builds at startup (reference: the native-module crash). It is loaded
// only on first use, only when the native side answers, and inside a try: any failure
// means "no in-app card sheet", and the card page opens in the in-app browser as before.

export type CardWebView = ComponentType<WebViewProps>;
type Registry = { get?: (_name: string) => unknown } | null | undefined;

/** The native module the package's own JavaScript requires before it can render. */
export const CARD_WEBVIEW_NATIVE_MODULE = 'RNCWebViewModule';

export function loadCardWebView(
  registry?: Registry,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  load: () => unknown = () => require('react-native-webview'),
): CardWebView | null {
  try {
    // Read inside the try: on a runtime without it, even reading the registry may throw.
    const native = registry === undefined ? TurboModuleRegistry as unknown as Registry : registry;
    if (typeof native?.get !== 'function' || !native.get(CARD_WEBVIEW_NATIVE_MODULE)) return null;
    const mod = load() as { WebView?: unknown } | null | undefined;
    const view = mod?.WebView;
    return view && (typeof view === 'function' || typeof view === 'object') ? view as CardWebView : null;
  } catch {
    return null;
  }
}

let cached: CardWebView | null | undefined;
/** The in-app card sheet's web view, or null on a build without it (decided once per app run). */
export function cardWebView(): CardWebView | null {
  if (cached === undefined) cached = loadCardWebView();
  return cached;
}
