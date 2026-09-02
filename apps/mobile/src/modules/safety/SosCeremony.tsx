import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, space, withAlpha } from '@swift/ui';
import { DecorativeIcon, PillButton, PopupCard, PopupTitle, T } from '../../kit';
import { isAxiosError } from 'axios';
import { openExternal } from '../../lib/openExternal';
import { useCancelSos, useConfirmSos, useJobSos, useServiceJobSos, type SosRaised } from '../../hooks/safety';
import { emergencyDialCopy, emergencyDialFor, useEmergencyPolicy } from '../../services/emergencyPolicy';
import { locationAccuracyBand, recordSosLocation, recordSosTransition, telUrl, type LocationAccuracyBand } from '../../lib/emergencyPolicy';

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
//  - The market's VERIFIED emergency number is dialed FIRST, before anything
//    Swift-side, always [MOB-018]; an unverified candidate is offered with a
//    tap; no trustworthy number is an honest manual dial sheet — never a
//    hard-coded 911 in a market that is not Guyana.
//  - Every rendered state is a SERVER fact (the raise response's status and
//    grace deadline; the confirm and cancel responses' status) — never an
//    assumption. A failed or unreadable confirm/cancel is UNKNOWN, an
//    unreachable server is OFFLINE, and only a real 409 SOS_NOT_CANCELLABLE
//    means "too late — help is being reached" [MOB-018].
//  - Failure is LOUD: "Swift was NOT alerted" + retry, never silent.
//  - "Page Swift now" (the confirm endpoint's first real caller) skips the
//    grace wait; "I'm OK" cancels inside the window; a 409 on cancel is
//    rendered honestly as "too late — help is being reached".
// ---------------------------------------------------------------------------

type SosContext = { orderId: string } | { serviceJobId: string };

const SOS_STATUSES: ReadonlyArray<SosRaised['status']> = ['TRIGGER_PENDING', 'ACTIVE', 'ACKNOWLEDGED', 'RESOLVED', 'CANCELLED'];

/** The status the SERVER answered, or null when the answer is not one — a
 *  missing or malformed status is UNKNOWN, never the status the button wanted. */
function serverStatus(data: unknown): SosRaised['status'] | null {
  const status = (data as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'string' && (SOS_STATUSES as readonly string[]).includes(status) ? (status as SosRaised['status']) : null;
}

/** A transport failure: no response at all (offline, DNS, timeout). */
function isOffline(err: unknown): boolean {
  return isAxiosError(err) && !err.response;
}

/** Exactly the server's "the grace window closed" answer — nothing else is that. */
function isSosNotCancellable(err: unknown): boolean {
  return isAxiosError(err) && err.response?.status === 409
    && (err.response.data as { error?: { code?: string } } | undefined)?.error?.code === 'SOS_NOT_CANCELLABLE';
}

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
  // [MOB-018] What the server did NOT say: an unreadable/failed confirm or
  // cancel is UNKNOWN, an unreachable server is OFFLINE. Never inferred ACTIVE.
  const [outcome, setOutcome] = useState<null | 'offline' | 'confirm-unknown' | 'cancel-unknown'>(null);
  // What evidence rode with the alert: the accuracy band of the coordinates attached at press time.
  const [attached, setAttached] = useState<LocationAccuracyBand | null>(null);
  const { country, dial } = useEmergencyPolicy();

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

  const dialNow = () => {
    const decision = emergencyDialFor(country, 'police');
    if (decision.kind === 'manual') return;
    void openExternal(telUrl(decision.number), `Couldn't start the call — dial ${decision.number} directly.`);
  };

  const startRaise = () => {
    // The market's VERIFIED number FIRST — Swift records evidence; it is not
    // the rescuer. An unverified candidate has its own "Dial" button above
    // and is never dialed silently; no number means the manual sheet.
    const decision = emergencyDialFor(country, 'police');
    if (decision.kind === 'auto') void openExternal(telUrl(decision.number), `Couldn't start the call — dial ${decision.number} directly.`);
    setOutcome(null);
    const coords = getCoords();
    const band = locationAccuracyBand(coords);
    recordSosLocation(band);
    setAttached(band);
    const onError = (err: unknown) => { if (isOffline(err)) setOutcome('offline'); };
    const onSuccess = (raised: SosRaised) => {
      setAlert(raised);
      announce(
        raised.status === 'ACTIVE'
          ? "Swift's safety team has been paged."
          : 'Alert saved. Swift pages its safety team in a few seconds unless you cancel.',
      );
    };
    if ('orderId' in context) jobSos.mutate({ jobId: context.orderId, coords }, { onSuccess, onError });
    else svcSos.mutate({ serviceJobId: context.serviceJobId, coords }, { onSuccess, onError });
  };

  const pageNow = () => {
    if (!alert || confirm.isPending) return;
    setOutcome(null);
    confirm.mutate(alert.id, {
      onSuccess: (data) => {
        // The SERVER's status, never the one this button hoped for.
        const status = serverStatus(data);
        if (!status) {
          recordSosTransition('ACTIVE', 'UNKNOWN');
          setOutcome('confirm-unknown');
          return;
        }
        if (status !== 'ACTIVE' && status !== 'ACKNOWLEDGED') recordSosTransition('ACTIVE', status);
        setAlert({ ...alert, status, graceEndsAt: status === 'TRIGGER_PENDING' ? alert.graceEndsAt : null });
        if (status === 'ACTIVE' || status === 'ACKNOWLEDGED') announce("Swift's safety team has been paged.");
      },
      onError: (err) => {
        recordSosTransition('ACTIVE', isOffline(err) ? 'OFFLINE' : 'ERROR');
        setOutcome(isOffline(err) ? 'offline' : 'confirm-unknown');
      },
    });
  };

  const cancelAlert = () => {
    if (!alert || cancel.isPending) return;
    setOutcome(null);
    cancel.mutate(alert.id, {
      onSuccess: (data) => {
        const status = serverStatus(data);
        if (status === 'CANCELLED') { setAlert({ ...alert, status: 'CANCELLED' }); return; }
        recordSosTransition('CANCELLED', status ?? 'UNKNOWN');
        if (status) setAlert({ ...alert, status });
        else setOutcome('cancel-unknown');
      },
      onError: (err) => {
        // ONLY a real 409 SOS_NOT_CANCELLABLE means the window closed on the
        // clock — help is being reached. Anything else is not that.
        if (isSosNotCancellable(err)) {
          setTooLateToCancel(true);
          setAlert({ ...alert, status: 'ACTIVE' });
          return;
        }
        recordSosTransition('CANCELLED', isOffline(err) ? 'OFFLINE' : 'ERROR');
        setOutcome(isOffline(err) ? 'offline' : 'cancel-unknown');
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
            {emergencyDialCopy(dial)} Swift will also alert its safety team and save
            your location on this {recordNoun}&apos;s record. Use only in a real emergency.
          </T>
          {dial.kind === 'confirm' ? (
            <PillButton
              label={`Dial ${dial.number}`}
              variant="outline"
              style={{ alignSelf: 'stretch', marginTop: space.md }}
              onPress={dialNow}
            />
          ) : null}
          {outcome === 'offline' ? (
            <View style={{ alignSelf: 'stretch', borderRadius: 12, backgroundColor: withAlpha(color.error, 0.1), borderWidth: 1, borderColor: withAlpha(color.error, 0.4), padding: space.md, marginTop: space.md }}>
              <T variant="label" tone="error" weight="semibold">
                You appear to be offline — Swift was NOT alerted.
              </T>
              <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
                Your emergency call is unaffected. Try again when you have signal.
              </T>
            </View>
          ) : null}
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
            label={raisePending ? 'Alerting Swift…' : raiseError ? 'Try alerting Swift again' : dial.kind === 'auto' ? 'Yes — get help now' : 'Alert Swift now'}
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
          {outcome ? (
            <View style={{ alignSelf: 'stretch', borderRadius: 12, backgroundColor: withAlpha(color.error, 0.1), borderWidth: 1, borderColor: withAlpha(color.error, 0.4), padding: space.md, marginTop: space.md }}>
              <T variant="label" tone="error" weight="semibold">
                {outcome === 'offline'
                  ? 'You appear to be offline — Swift could not be reached.'
                  : outcome === 'confirm-unknown'
                    ? 'We could not confirm Swift was paged.'
                    : 'We could not confirm the alert was cancelled.'}
              </T>
              <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
                {outcome === 'cancel-unknown'
                  ? 'The alert may still page Swift when the countdown ends. Try cancelling again.'
                  : 'The countdown above is the server’s clock: Swift pages its team when it ends. Your emergency call is unaffected — try again.'}
              </T>
            </View>
          ) : null}
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
            {attached === 'none' || attached === null
              ? 'No location could be attached — tell the safety team where you are when they call. '
              : attached === 'under_50m'
                ? 'Your position at the moment you pressed (within about 50 m) is on the alert. '
                : attached === 'under_250m'
                  ? 'Your position at the moment you pressed (within about 250 m) is on the alert. '
                  : attached === 'over_250m'
                    ? 'A rough position (accuracy worse than 250 m) is on the alert — tell the team where you are. '
                    : 'Your position at the moment you pressed is on the alert. '}
            Keep your phone with you if you can.
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
