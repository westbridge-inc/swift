import { Platform } from 'react-native';

/**
 * [#910's law, generalized] Dismissing a windowed Modal (PopupCard,
 * ConfirmDialog, ActionSheet) in the SAME TICK a navigation transition starts
 * is the classic React Native wedge: the Modal's native window can survive the
 * race invisibly, floating above the destination screen and eating every
 * touch. That was the founder's frozen-tracking-screen P0, and the sweep that
 * followed found the same shape on four more ceremonies.
 *
 * The law: a modal exit may only CLOSE the modal in its own tick. The
 * navigation goes through here — after interactions, a beat later, when the
 * window is provably gone.
 *
 *   setOpen(false);
 *   afterDismiss(() => navigation.navigate('Somewhere'));
 *
 * (CartScreen's order-placed ceremony predates this seam and keeps its own
 * staged-effect variant, pinned by cartCeremonyNav.test.ts — its modal is
 * driven by mutation state, not a local boolean, so it needs the flush gate.)
 */
export function afterDismiss(go: () => void): void {
  // WAS: InteractionManager.runAfterInteractions(go).
  //
  // React Native 0.85 replaced InteractionManager with `InteractionManagerStub`
  // — `runAfterInteractions` is now a bare `setImmediate` that waits for no
  // interaction, no animation and no window teardown. The call still compiled,
  // still returned a cancellable handle, and still read like a guard. It had
  // stopped being one, and the frozen-screen P0 above came back.
  //
  // Two frames, because one is not enough: the first lets React commit the
  // modal's removal, the second lets the platform present that commit. On iOS
  // a caller that can reach the modal itself should prefer `PopupCard`'s
  // `onDismissed` — that is the real signal; this is the floor beneath it.
  if (Platform.OS === 'android') { go(); return; }
  requestAnimationFrame(() => requestAnimationFrame(go));
}
