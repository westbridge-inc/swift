import { InteractionManager } from 'react-native';

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
  InteractionManager.runAfterInteractions(go);
}
