/** @jsxImportSource react */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import type { Feather } from '@expo/vector-icons';
import { space } from '@swift/ui';
import { useAuthStore } from '../stores/authStore';
import { PillButton } from './button';
import { PopupCard, PopupTitle } from './card';
import { IconChip } from './rows';
import { T } from './text';

/**
 * THE ONE "LOG YOU OUT?" ASK. Every control a person presses to leave their
 * own account opens this first, the way every other app does, and only "Log
 * out" inside it ends the session. It lives here once so four rules hold on
 * every surface:
 *
 *  1. The teardown is the auth store's own logout(): the same server revoke,
 *     cache clear, socket and GPS shutdown as before. Nothing is re-expressed.
 *  2. "Stay signed in", a tap on the backdrop and Android's back button close
 *     the dialog and do nothing else.
 *  3. "Log out" ends the session exactly once. The first press stages the
 *     exit; every later press, however fast, finds it staged and does nothing.
 *  4. The dialog closes BEFORE the session ends [#910's law, see
 *     after-dismiss.ts]. Logging out swaps the whole navigator, and a modal
 *     still dismissing when that happens can leave its native window floating
 *     over the next screen, eating every touch. On iOS the exit waits for
 *     PopupCard's `onDismissed`, the real post-teardown signal; elsewhere it
 *     waits two frames after the close render. A one-second floor ends it if
 *     that signal can no longer come.
 *
 * Forced log-outs never come here. An expired session, a refresh the server
 * refused and a deleted account end through `logoutIfCurrent` on their own;
 * asking would be a lie, because the session is already gone.
 *
 * A guest has no session to end. Their "Log out" (the sample business
 * dashboard, the driver preview) only leaves the preview, so it runs at once:
 * the ask is about an account, and they do not have one.
 */

type FeatherName = React.ComponentProps<typeof Feather>['name'];

export interface LogoutConfirmOptions {
  /** What leaving costs on THIS surface, in plain words: exactly what is lost
   *  and what stays. Required, because each surface has its own truth. */
  body: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmIcon?: FeatherName;
  /** Wraps the teardown (the advertiser exit clears its intent first). It is
   *  handed the store's own logout() and must end in it. */
  onLogout?: (logout: () => void) => void;
}

export interface LogoutConfirm {
  /** Wire a log-out control's onPress here. */
  requestLogout: () => void;
  /** Render once, anywhere in the screen. Without it the control does nothing. */
  logoutDialog: React.ReactElement;
}

type Phase = 'closed' | 'asking' | 'leaving';

/** The popup fades out in about 300 ms. If the dialog's own "gone" signal has
 *  not arrived a full second after it closed, it is not coming. */
const DISMISS_FLOOR_MS = 1000;

/** A confirmed exit, held until the dialog is provably gone. The principal
 *  generation it was confirmed under lets a session that ended some other way
 *  in between (expiry, a refused refresh) be left alone, not ended twice. */
interface StagedExit {
  generation: number;
  leave: () => void;
}

export function useLogoutConfirm({
  body,
  title = 'Log out of Swift?',
  confirmLabel = 'Log out',
  cancelLabel = 'Stay signed in',
  confirmIcon,
  onLogout,
}: LogoutConfirmOptions): LogoutConfirm {
  const signedIn = useAuthStore((state) => state.isAuthenticated);
  const logout = useAuthStore((state) => state.logout);
  const [phase, setPhase] = useState<Phase>('closed');
  const staged = useRef<StagedExit | null>(null);

  const leave = useCallback(() => (onLogout ? onLogout(logout) : logout()), [onLogout, logout]);

  const finish = useCallback(() => {
    const exit = staged.current;
    if (!exit) return;
    staged.current = null;
    setPhase('closed');
    if (useAuthStore.getState().sessionGeneration !== exit.generation) return;
    exit.leave();
  }, []);

  // Modal.onDismiss is iOS-only. Elsewhere the exit waits two frames: the
  // first commits the dialog's removal, the second presents it. On every
  // platform a floor well past the fade keeps the choice alive: a dialog torn
  // down before its signal could arrive (its screen switched branches and
  // rendered it elsewhere) must not leave the person stuck signed in.
  useEffect(() => {
    if (phase !== 'leaving') return;
    let firstFrame = 0;
    let secondFrame = 0;
    if (Platform.OS !== 'ios') {
      firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(finish);
      });
    }
    const floor = setTimeout(finish, DISMISS_FLOOR_MS);
    return () => {
      if (firstFrame) cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
      clearTimeout(floor);
    };
  }, [phase, finish]);

  // The person asked to leave. If the screen goes away while the dialog is
  // still closing, that choice still stands.
  useEffect(() => finish, [finish]);

  const requestLogout = useCallback(() => {
    if (staged.current) return;
    if (!signedIn) {
      leave();
      return;
    }
    setPhase('asking');
  }, [signedIn, leave]);

  const stay = () => {
    if (!staged.current) setPhase('closed');
  };

  const confirm = () => {
    if (phase !== 'asking' || staged.current) return;
    staged.current = { generation: useAuthStore.getState().sessionGeneration, leave };
    setPhase('leaving');
  };

  return {
    requestLogout,
    logoutDialog: (
      <PopupCard visible={phase === 'asking'} onClose={stay} onDismissed={finish}>
        <IconChip icon="log-out" size={56} />
        <PopupTitle variant="heading" center style={{ marginTop: space.md }}>
          {title}
        </PopupTitle>
        <T variant="label" tone="muted" center style={{ marginTop: space.sm }}>
          {body}
        </T>
        <View style={{ alignSelf: 'stretch', gap: space.md, marginTop: space.xl }}>
          <PillButton label={confirmLabel} icon={confirmIcon} size="md" onPress={confirm} />
          <PillButton label={cancelLabel} variant="soft" size="md" onPress={stay} />
        </View>
      </PopupCard>
    ),
  };
}
