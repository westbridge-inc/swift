/** @jsxImportSource react */
import React from 'react';
import { WeeklyFeeScreen } from '../../billing/screens/WeeklyFeeScreen';
import { useMoverKind, useMoverSubscription } from '../../../hooks';

export function MoverSwiftNumberScreen({ route }: { route?: { params?: { ref?: string } } }) {
  const { kind, loading } = useMoverKind();
  const q = useMoverSubscription(kind);
  return <WeeklyFeeScreen key={kind} family={kind === 'DRIVER' ? 'driver' : 'rider'} sub={q.data} loading={loading || q.isLoading} error={q.isError} refresh={q.refetch} checkoutRef={route?.params?.ref} />;
}
