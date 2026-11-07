import type React from 'react';
import { useCallParty } from '../hooks/useCallParty';
import type { CallTarget } from '../lib/callBridge';

type Control = ReturnType<typeof useCallParty>;

/**
 * [O-1] The Call control for one person on an order, as a render prop so each screen keeps its own
 * look. Renders nothing when there is neither a Swift call nor a number to dial (chat and support stay).
 * Bridge off: exactly today's dialler button. Bridge on: "Call via Swift".
 */
export function CallParty(props: {
  orderId?: string | null;
  target: CallTarget;
  phone?: string | null;
  dialFailText: string;
  children: (call: Control) => React.ReactElement | null;
}): React.ReactElement | null {
  const call = useCallParty(props);
  return call.visible ? props.children(call) : null;
}
