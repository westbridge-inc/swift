import type React from 'react';
import { useInAppCall } from '../hooks/useInAppCall';
import type { CallTarget } from '../lib/callBridge';

type Control = ReturnType<typeof useInAppCall>;

/**
 * [INAPP-CALLS] "Call in app" for one person on an order, beside "Call via Swift", as a render prop so each
 * screen keeps its own look. Renders nothing unless the server switch is on, this build has the calling
 * module (build 13+), and the person is not the parcel recipient. Never a number.
 */
export function CallInApp(props: {
  orderId?: string | null;
  target: CallTarget;
  children: (call: Control) => React.ReactElement | null;
}): React.ReactElement | null {
  const call = useInAppCall(props);
  return call.visible ? props.children(call) : null;
}
