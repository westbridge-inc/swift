import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, space, withAlpha } from '@swift/ui';
import { DecorativeIcon, PillButton, PopupCard, PopupTitle, T } from '../../kit';
import { openExternal } from '../../lib/openExternal';
import { useCancelSos, useConfirmSos, useJobSos, useServiceJobSos, type SosRaised } from '../../hooks/safety';

// ---------------------------------------------------------------------------
// [REPORT-035 F-035-01/09 · S0] THE SOS CEREMONY — one component, because the
// same life-safety defect shipped three times (DeliveryScreen, ActiveJob,
// ServiceJobs): the popup closed the instant the request left the phone and
// showed success copy unconditionally. A network failure raised NOTHING while
// the person believed Swift was tracking them; and nothing ever called the
// confirm endpoint, so every alert sat in its grace window waiting for a
// background worker to page ops.
//
// The rules this component encodes:
//  - 911 is dialed FIRST, before anything Swift-side, always.
//  - Every rendered state is a SERVER fact (the raise response's status and
//    grace deadline) — never an assumption.
//  - Failure is LOUD: "Swift was NOT alerted" + retry, never silent.
//  - "Page Swift now" (the confirm endpoint's first real caller) skips the
//    grace wait; "I'm OK" cancels inside the window; a 409 on cancel is
//    rendered honestly as "too late — help is being reached".
// ---------------------------------------------------------------------------

type SosContext = { orderId: string } | { serviceJobId: string };

export function SosCeremony({
  visible,
  onClose,
  context,
  getCoords,
  recordNoun,
}: {
  visible: boolean;
  onClose: () => void;
  context: SosContext;
  /** MY coordinates, never the other party's — resolved at press time. */
  getCoords: () => { lat: number; lng: number; accuracyM?: number } | undefined;
  /** "order" | "job" — the record the alert attaches to, for the copy. */
  recordNoun: string;
}) {
  const jobSos = useJobSos();
  const svcSos = useServiceJobSos();
  const confirm = useConfirmSos();
  const cancel = useCancelSos();

  const [alert, setAlert] = useState<SosRaised | null>(null);
  const [tooLateToCancel, setTooLateToCancel] = useState(false);
  const [graceLeft, setGraceLeft] = useState<number | null>(null);

  const raisePending = jobSos.isPending || svcSos.isPending;
  const raiseError = ('orderId' in context ? jobSos.isError : svcSos.isError) && !alert;

  // The grace countdown reads the SERVER deadline; when it passes, the worker
  // is promoting — say that, don't keep a dead countdown alive.
  useEffect(() => {
    if (!alert || alert.status !== 'TRIGGER_PENDING' || !alert.graceEndsAt) {
      setGraceLeft(null);
      return;
    }
    const endsAt = new Date(alert.graceEndsAt).getTime();
    if (!Number.isFinite(endsAt)) return;
    const tick = () => setGraceLeft(Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [alert]);

  const announced = useRef<string | null>(null);
  const announce = (msg: string) => {
    if (announced.current === msg) return;
    announced.current = msg;
    AccessibilityInfo.announceForAccessibility(msg);
  };

  const startRaise = () => {
    // 911 FIRST — Swift records evidence; it is not the rescuer.
    void openExternal('tel:911', "Couldn't start the call — dial 911 directly.");
    const coords = getCoords();
    const onSuccess = (raised: SosRaised) => {
      setAlert(raised);
      announce(
        raised.status === 'ACTIVE'
          ? "Swift's safety team has been paged."
          : 'Alert saved. Swift pages its safety team in a few seconds unless you cancel.',
      );
    };
    if ('orderId' in context) jobSos.mutate({ jobId: context.orderId, coords }, { onSuccess });
    else svcSos.mutate({ serviceJobId: context.serviceJobId, coords }, { onSuccess });
  };

  const pageNow = () => {
    if (!alert || confirm.isPending) return;
    confirm.mutate(alert.id, {
      onSuccess: () => {
        setAlert({ ...alert, status: 'ACTIVE' });
        announce("Swift's safety team has been paged.");
      },
    });
  };

  const cancelAlert = () => {
    if (!alert || cancel.isPending) return;
    cancel.mutate(alert.id, {
      onSuccess: () => setAlert({ ...alert, status: 'CANCELLED' }),
      onError: () => {
        // 409: the window closed on the clock — help is being reached.
        setTooLateToCancel(true);
        setAlert({ ...alert, status: 'ACTIVE' });
      },
    });
  };

  const live = alert && (alert.status === 'TRIGGER_PENDING' || alert.status === 'ACTIVE' || alert.status === 'ACKNOWLEDGED');
  const paged = alert && alert.status !== 'TRIGGER_PENDING' && alert.status !== 'CANCELLED';

  // ONE semantic PopupTitle per dialog (the popupSemantics gate) — the phase
  // changes its words, never its landmark.
  const title = !alert
    ? 'Get emergency help?'
    : alert.status === 'TRIGGER_PENDING'
      ? 'Alert saved'
      : paged
        ? "Swift's safety team has been paged"
        : 'Alert cancelled';

  return (
    <PopupCard visible={visible} onClose={onClose}>
      <DecorativeIcon style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: live ? color.error : alert?.status === 'CANCELLED' ? color.surface.sunken : color.error }}>
        <Feather name={alert?.status === 'CANCELLED' ? 'check' : 'alert-triangle'} size={32} color={alert?.status === 'CANCELLED' ? color.text.secondary : color.white} />
      </DecorativeIcon>
      <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
        {title}
      </PopupTitle>

      {!alert ? (
        <>
          <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
            This dials 911 — local emergency services — right away. Swift will also
            alert its safety team and save your location on this {recordNoun}&apos;s
            record. Use only in a real emergency.
          </T>
          {raiseError ? (
            <View style={{ alignSelf: 'stretch', borderRadius: 12, backgroundColor: withAlpha(color.error, 0.1), borderWidth: 1, borderColor: withAlpha(color.error, 0.4), padding: space.md, marginTop: space.md }}>
              <T variant="label" tone="error" weight="semibold">
                Swift was NOT alerted — the request failed.
              </T>
              <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
                Your 911 call is unaffected. Check your connection and try again so
                Swift can track and record this emergency.
              </T>
            </View>
          ) : null}
          <PillButton
            label={raisePending ? 'Alerting Swift…' : raiseError ? 'Try alerting Swift again' : 'Yes — get help now'}
            loading={raisePending}
            style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
            onPress={startRaise}
          />
          <PillButton label="Close" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={onClose} />
        </>
      ) : alert.status === 'TRIGGER_PENDING' ? (
        <>
          <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
            {graceLeft != null && graceLeft > 0
              ? `Swift pages its safety team in ${graceLeft}s unless you cancel.`
              : 'Swift is paging its safety team now.'}
          </T>
          <PillButton
            label={confirm.isPending ? 'Paging…' : 'Page Swift NOW'}
            loading={confirm.isPending}
            style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
            onPress={pageNow}
          />
          {graceLeft != null && graceLeft > 0 ? (
            <PillButton
              label={cancel.isPending ? 'Cancelling…' : "I'm OK — cancel the alert"}
              variant="outline"
              loading={cancel.isPending}
              style={{ alignSelf: 'stretch', marginTop: space.md }}
              onPress={cancelAlert}
            />
          ) : null}
          <PillButton label="Close" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={onClose} />
        </>
      ) : paged ? (
        <>
          <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
            {tooLateToCancel
              ? 'The cancel window had already closed — help is being reached. '
              : ''}
            Your location is on the safety team&apos;s live map. Keep your phone with
            you if you can.
          </T>
          <PillButton label="Close" style={{ alignSelf: 'stretch', marginTop: space['2xl'] }} onPress={onClose} />
        </>
      ) : (
        <>
          <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
            Nobody was paged. If anything changes, press the emergency button again.
          </T>
          <PillButton
            label="Close"
            style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
            onPress={() => {
              setAlert(null);
              setTooLateToCancel(false);
              onClose();
            }}
          />
        </>
      )}
    </PopupCard>
  );
}
