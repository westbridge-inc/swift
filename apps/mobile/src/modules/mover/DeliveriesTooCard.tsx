/** @jsxImportSource react */
import React from 'react';
import type { ViewStyle } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { space } from '@swift/ui';
import { Card, PillButton, T } from '../../kit';
import { toast } from '../../kit/toast';
import { driverApi } from '../../services/api';
import { useSelectMoverKind } from '../../hooks/mover';
import { useMoverPreview } from '../../stores/moverPreview';
import { serverMessage } from '../../lib/stepUp';
import { deliveriesTooView, type WorkKind } from '../../lib/deliveriesToo';

/**
 * [CARS-DELIVER] The account card for "Deliveries too" (lib/deliveriesToo.ts decides what it says). Hidden
 * unless the server says the taxi car can take deliveries now, or already does — so while CAR_DELIVERIES is
 * off nobody sees it. "Add deliveries" sets up the delivery profile on the taxi car (POST /driver/deliveries;
 * the server checks the taxi papers and answers in its own words); the switch button moves the work mode.
 * Asked only for an account with a taxi profile (`hasTaxiProfile`), never in the earner preview. The screen
 * gives it its place in the stack (`style`, the one marginTop every account card keeps).
 */
export function DeliveriesTooCard({ kind, hasTaxiProfile, style }: { kind: WorkKind | null; hasTaxiProfile: boolean; style?: ViewStyle }) {
  const preview = useMoverPreview((state) => state.preview);
  const qc = useQueryClient();
  const status = useQuery<unknown>({
    queryKey: ['mover', 'carDeliveries'],
    queryFn: async () => (await driverApi.carDeliveries())?.data?.data ?? null,
    enabled: !preview && hasTaxiProfile,
    retry: 0,
  });
  const add = useMutation({
    mutationFn: () => driverApi.addCarDeliveries(),
    onSuccess: () => {
      toast.success('Deliveries added', 'Switch to deliveries when you want store orders.');
      void qc.invalidateQueries({ queryKey: ['mover'] });
    },
    onError: (e: unknown) => toast.error('Deliveries not added', serverMessage(e, 'Check your connection and try again.')),
  });
  // [PR4] "Taxi rides and deliveries" on or off (PUT /driver/deliveries/mode); the server answers with the card's status.
  const setBoth = useMutation({
    mutationFn: (on: boolean) => driverApi.setCarDeliveriesMode(on),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['mover', 'carDeliveries'] }); },
    onError: (e: unknown) => toast.error('Not changed', serverMessage(e, 'Check your connection and try again.')),
  });
  const selectKind = useSelectMoverKind();
  if (preview || !hasTaxiProfile) return null;
  const view = deliveriesTooView(status.data, kind);
  if (!view.show) return null;
  return (
    <Card style={style}>
      <T variant="body" weight="semibold">{view.title}</T>
      <T variant="caption" tone="muted" style={{ marginTop: 4 }}>{view.body}</T>
      {view.state === 'offer' ? (
        <PillButton
          label={add.isPending ? 'Adding…' : view.action}
          loading={add.isPending}
          disabled={add.isPending}
          style={{ marginTop: space.md }}
          onPress={() => add.mutate()}
        />
      ) : null}
      {view.state === 'ready' ? (
        <>
          <PillButton
            label={selectKind.isPending ? 'Switching…' : view.action}
            variant="outline"
            loading={selectKind.isPending}
            disabled={selectKind.isPending}
            style={{ marginTop: space.md }}
            onPress={() => selectKind.mutate(view.target)}
          />
          {selectKind.isError ? (
            <T variant="caption" tone="error" style={{ marginTop: space.sm }}>
              {serverMessage(selectKind.error, 'We couldn’t switch work modes. Finish any active job, check your connection and try again.')}
            </T>
          ) : null}
          {view.both ? (
            <>
              <T variant="caption" tone="muted" style={{ marginTop: space.md }}>{view.both.line}</T>
              <PillButton
                label={setBoth.isPending ? 'Saving…' : view.both.label}
                variant={view.both.on ? 'outline' : 'primary'}
                loading={setBoth.isPending}
                disabled={setBoth.isPending}
                style={{ marginTop: space.sm }}
                onPress={() => setBoth.mutate(!view.both!.on)}
              />
            </>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
