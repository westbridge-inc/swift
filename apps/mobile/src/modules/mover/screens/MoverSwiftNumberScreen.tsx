/** @jsxImportSource react */
import React from 'react';
import { WeeklyFeeScreen } from '../../billing/screens/WeeklyFeeScreen';
import { useMoverKind, useMoverSubscription } from '../../../hooks';
import { useCheckingLatest } from '../../../lib/checkingLatest';

export function MoverSwiftNumberScreen({ route }: { route?: { params?: { ref?: string } } }) {
  const { kind, loading } = useMoverKind();
  const q = useMoverSubscription(kind);
  const checkingLatest = useCheckingLatest(q);
  return <WeeklyFeeScreen key={kind} family={kind === 'DRIVER' ? 'driver' : 'rider'} sub={q.data} loading={loading || q.isLoading} error={q.isError} refresh={q.refetch} checkoutRef={route?.params?.ref} checkingLatest={checkingLatest} />;
}
