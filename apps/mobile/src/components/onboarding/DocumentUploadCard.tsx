import { useEffect, useRef, useState } from 'react';
import { Alert, Linking, Pressable, View, ActivityIndicator } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useNavigation } from '@react-navigation/native';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { Badge, BrandCheckbox, Card, LinkText, T } from '../../kit';
import { useUploadDocument, useWithdrawPoliceClearance } from '../../hooks/verification';
import {
  AuthSessionBoundaryError,
  requireAuthSessionForPrincipal,
  requireAuthSessionSnapshot,
} from '../../stores/authStore';
import type { AuthSessionSnapshot } from '../../lib/authSession';
import { pendingDocumentLabel } from './documentChecklistPresentation';
import { docLabel } from './docLabels';
import { DOCUMENT_CONSENT_TEXT } from '../../lib/uploadConsentCopy';
import { SENSITIVE_CONSENT_ASK, policeWithdrawOutcome, type PoliceClearanceWords } from './documentConsentRecord';
import type { UploadConsentVia } from '../../services/api';

const label = docLabel;
/** Friendly document name for other surfaces (suspension banners etc.); the names live in ./docLabels. */
export { docLabel };
// Safe, always-present icons only.
const docIcon = (docType: string): keyof typeof MaterialCommunityIcons.glyphMap =>
  docType.includes('photo') || docType === 'selfie'
    ? 'camera-outline'
    : docType.includes('national_id') || docType.includes('licence')
      ? 'card-account-details-outline'
      : 'file-document-outline';

type DocStatus = 'APPROVED' | 'PENDING' | 'REJECTED' | 'EXPIRED' | undefined;

const DAY_MS = 24 * 60 * 60 * 1000;
// Mirrors the API's renewal window: re-submission opens 30 days before expiry.
const RENEWAL_WINDOW_DAYS = 30;

export function DocumentUploadCard({
  role,
  docType,
  status,
  expiresAt,
  submittedAt,
  reviewNote,
  isNext,
  replaced = false,
  optionalHint,
  hint,
  consented = false,
  askConsentFirst = false,
  consentVia = 'checkbox',
  policeConsent = null,
}: {
  role: string;
  docType: string;
  status: DocStatus;
  expiresAt?: string | null;
  submittedAt?: string | null;
  reviewNote?: string | null;
  isNext?: boolean;
  /** [REPLACE-PENDING] This copy replaced an earlier one that was still waiting for review. */
  replaced?: boolean;
  /** [VERIFY-DOCS] Set for a document the person MAY add: what it is for. Never a gate, so no
   *  "keep operating" copy and no "next step" nudge. */
  optionalHint?: string;
  /** [Owner ruling 11 Oct 2026] What this document is, in plain words (taxi checklist). */
  hint?: string;
  /** [R17] The checklist's consent tick is given: only then can a document be uploaded. */
  consented?: boolean;
  /** [DOC-CONSENT · DPA s.9(1)(a), research D1] The tick on screen stands only on the person's record and this
   *  document is sensitive (a police clearance): ask for the consent again, in the ledger's words, before the photo. */
  askConsentFirst?: boolean;
  /** [DOC-CONSENT S4] How the checklist's tick was given (ticked on this visit, or shown from the record); the
   *  police-clearance prompt overrides it with 'prompt'. Sent with the upload so the ledger says it truly. */
  consentVia?: UploadConsentVia;
  /** [POLICE-CLEARANCE CONSENT] A police clearance's OWN consent, in the API's words: its own box (unticked, asked
   *  for each upload) opens the card instead of the list's tick, and a clearance on file can be withdrawn. Null (an
   *  older API, or any other document): the list's tick and the ask above, as before. */
  policeConsent?: PoliceClearanceWords | null;
}) {
  const upload = useUploadDocument(role);
  const withdraw = useWithdrawPoliceClearance(role);
  // [POLICE-CLEARANCE CONSENT] The card's own box: never ticked for anyone, emptied after each upload.
  const [policeTicked, setPoliceTicked] = useState(false);
  const ownTick = policeConsent !== null;
  // A tick belongs to the words it was given to: new words (the API changed them) start empty.
  const wordsVersion = policeConsent?.version ?? null;
  useEffect(() => { setPoliceTicked(false); }, [wordsVersion]);
  const canUpload = ownTick ? policeTicked : consented;
  const navigation = useNavigation<any>();
  const expired = status === 'EXPIRED';
  const pending = status === 'PENDING';
  const rejected = status === 'REJECTED';
  const daysLeft = expiresAt ? Math.ceil((new Date(expiresAt).getTime() - Date.now()) / DAY_MS) : null;
  const expiringSoon = status === 'APPROVED' && daysLeft != null && daysLeft <= RENEWAL_WINDOW_DAYS;
  // An approved doc inside its renewal window re-opens for upload.
  const approved = status === 'APPROVED' && !expiringSoon;
  // [REPLACE-PENDING · owner request 8 Oct] A copy waiting for review can be replaced (sent the wrong one);
  // the server keeps the old copy for audit and the reviewer sees only the newest.
  const pendingLabel = pendingDocumentLabel(replaced, submittedAt);

  // [DOC-CONSENT S4] How the consent for the photo being picked was given: set when the photo choice opens.
  const consentSource = useRef<UploadConsentVia>(consentVia);
  const send = (a: ImagePicker.ImagePickerAsset, authSession: AuthSessionSnapshot) =>
    upload.mutate({
      docType,
      file: { uri: a.uri, name: a.fileName ?? `${docType}.jpg`, type: a.mimeType ?? 'image/jpeg' },
      authSession,
      consentVia: consentSource.current,
      ...(policeConsent ? { consent: { tick: policeConsent.tick, version: policeConsent.version } } : {}),
    }, { onSuccess: () => setPoliceTicked(false) });


/** G9: a denied permission must never be a silent dead end. On iOS the OS
 *  prompt appears ONCE — after that every tap returns instantly denied, the
 *  sheet just closes, and the only fix lives in the Settings app where nothing
 *  points. A mover who cannot upload a licence cannot verify, go online, or
 *  earn; they conclude the app is broken and leave. So: when the system can
 *  still ask (`canAskAgain`), stay quiet — the OS prompt is the message. When
 *  it cannot, say so and offer BOTH ways out: Settings, and the OTHER source
 *  (camera and library are separate permissions, so each is the other's
 *  genuine escape hatch). */
function explainPermissionDenied(
  which: 'camera' | 'library',
  canAskAgain: boolean,
  useOther: () => void,
): void {
  if (canAskAgain) return; // dismissing the OS prompt is not a decision — don't nag
  const what = which === 'camera' ? 'camera' : 'photo library';
  const other = which === 'camera' ? 'Choose from library' : 'Take photo';
  Alert.alert(
    which === 'camera' ? 'Camera is turned off for Swift' : 'Photo access is turned off for Swift',
    `Swift needs ${what} access to add your documents. Turn it on in Settings, or use the other option instead.`,
    [
      { text: 'Open Settings', onPress: () => { void Linking.openSettings(); } },
      { text: other, onPress: useOther },
      { text: 'Cancel', style: 'cancel' },
    ],
  );
}

  const fromCamera = async () => {
    try {
      const owner = requireAuthSessionSnapshot();
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      requireAuthSessionForPrincipal(owner);
      if (!perm.granted) {
        explainPermissionDenied('camera', perm.canAskAgain, () => { void fromLibrary(); });
        return;
      }
      const res = await ImagePicker.launchCameraAsync({ quality: 0.8 });
      requireAuthSessionForPrincipal(owner);
      if (!res.canceled && res.assets?.[0]) send(res.assets[0], owner);
    } catch (cameraError) {
      if (!(cameraError instanceof AuthSessionBoundaryError)) throw cameraError;
    }
  };

  const fromLibrary = async () => {
    try {
      const owner = requireAuthSessionSnapshot();
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      requireAuthSessionForPrincipal(owner);
      if (!perm.granted) {
        explainPermissionDenied('library', perm.canAskAgain, () => { void fromCamera(); });
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.8,
      });
      requireAuthSessionForPrincipal(owner);
      if (!res.canceled && res.assets?.[0]) send(res.assets[0], owner);
    } catch (libraryError) {
      if (!(libraryError instanceof AuthSessionBoundaryError)) throw libraryError;
    }
  };

  // Docs are photographed at the counter/kerb more often than they sit in the
  // gallery — offer the camera first, library as the alternative.
  const choosePhoto = (via: UploadConsentVia) => {
    consentSource.current = via;
    Alert.alert(label(docType), docType === 'vehicle_exterior_photo'
      ? 'Show the whole car, with its number plate clearly readable. Well lit, no glare.'
      : 'Add a clear, well-lit photo. All corners visible, no glare.', [
      ...(upload.isError && upload.variables ? [{ text: 'Retry saved photo', onPress: () => upload.mutate(upload.variables!) }] : []),
      { text: 'Take photo', onPress: fromCamera },
      { text: 'Choose from library', onPress: fromLibrary },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };
  // [DOC-CONSENT] The start of every upload (a first one, a re-upload, a replacement). A sensitive document whose
  // tick stands only on the record asks first, in the exact words the ledger anchors the upload to; only
  // "I consent" goes on to the photo. Every other upload starts at the photo, as before.
  // [POLICE-CLEARANCE CONSENT] Its own box is the explicit consent for this upload: no second ask.
  const pick = ownTick
    ? () => choosePhoto('checkbox')
    : askConsentFirst
    ? () => Alert.alert(label(docType), `${SENSITIVE_CONSENT_ASK}\n\n${DOCUMENT_CONSENT_TEXT}`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'I consent', onPress: () => choosePhoto('prompt') },
    ])
    : () => choosePhoto(consentVia);
  const confirmWithdraw = () => {
    if (!policeConsent) return;
    Alert.alert('Withdraw your police clearance?', policeConsent.withdrawConfirm, [
      { text: 'Cancel', style: 'cancel' },
      // [REVIEW-F #2111 S3-1] Then say what happened, from the API's answer (deleted, or kept for a legal reason).
      {
        text: 'Withdraw',
        style: 'destructive',
        onPress: () => withdraw.mutate(undefined, {
          onSuccess: (answer) => { const outcome = policeWithdrawOutcome(answer); Alert.alert(outcome.title, outcome.message); },
        }),
      },
    ]);
  };
  const confirmReplace = () =>
    Alert.alert('Replace this document?', 'Your new upload replaces the one waiting for review. We keep the old one on record, and the reviewer sees only the new one.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Replace', onPress: pick },
    ]);

  // The server's rejection reason is the fix instruction — surface it verbatim.
  const uploadErr = upload.isError
    ? ((upload.error as any)?.response?.data?.error?.message ?? 'Upload failed — tap to try again')
    : null;

  const caption = !canUpload && !approved && !pending && !uploadErr
    ? (ownTick ? 'Tick the box below to upload' : 'Tick the box above to upload')
    : uploadErr
    ? uploadErr
    : approved
      ? daysLeft != null
        ? `Approved — valid until ${new Date(expiresAt!).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
        : 'Approved'
      : expiringSoon
        ? `Expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} — tap to upload the renewal`
        : expired
          ? optionalHint
            ? 'Expired — optional, upload a new one any time'
            : 'Expired — upload the renewal to keep operating'
          : pending
            ? pendingLabel
            : rejected
              ? reviewNote
                ? `Rejected: ${reviewNote} — tap to re-upload`
                : 'Rejected — tap to re-upload'
              : optionalHint
                ? 'Optional'
                : isNext
                  ? 'Recommended next step'
                  : 'Get started';

  return (
    <Pressable disabled={approved || upload.isPending || !canUpload} onPress={pending ? confirmReplace : pick}>
      <Card
        style={[
          { marginBottom: space.sm, flexDirection: 'row', alignItems: 'center' },
          // The recommended-next card wears a visible brand edge, not just a
          // colour with no width (the old ternary set borderColor alone).
          isNext && !status ? { borderWidth: 1, borderColor: color.brand[500] } : null,
        ]}
      >
        <View style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.full, backgroundColor: color.surface.subtle }}>
          <MaterialCommunityIcons
            name={approved ? 'check-decagram' : docIcon(docType)}
            size={20}
            color={approved ? color.success : expired || expiringSoon ? color.warning : color.brand[500]}
          />
        </View>
        <View style={{ marginLeft: space.md, flex: 1 }}>
          <T
            variant="micro"
            tone="muted"
            style={uploadErr || rejected ? { color: color.error } : expiringSoon || expired ? { color: color.warning } : undefined}
          >
            {upload.isPending ? 'Still uploading — keep this screen open. Slow connections can take a minute.' : caption}
          </T>
          <T variant="body" weight="semibold">{label(docType)}</T>
          {/* [Legal research G4, in-app ¶17] The card no longer says a face was matched: identity checks are made
              by people (face-matching is off, GUARDRAILS §8). The checklist says what really happens. */}
          {hint ? (
            <T variant="micro" tone="muted" style={{ marginTop: 2 }}>
              {hint}
            </T>
          ) : null}
          {optionalHint ? (
            <T variant="micro" tone="muted" style={{ marginTop: 2 }}>
              {optionalHint}
            </T>
          ) : null}
        </View>
        {upload.isPending ? (
          <ActivityIndicator />
        ) : approved ? (
          <Badge label="Approved" tone="success" />
        ) : expired ? (
          <Badge label="Expired" tone="error" />
        ) : rejected ? (
          <Badge label="Rejected" tone="error" />
        ) : pending ? (
          <Badge label="In review" tone="brand" />
        ) : (
          <Feather name="chevron-right" size={20} color={color.text.muted} />
        )}
      </Card>
      {/* [POLICE-CLEARANCE CONSENT] The clearance's own box, in the API's words, for each upload. */}
      {policeConsent && !approved ? (
        <Pressable
          onPress={() => setPoliceTicked((t) => !t)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: policeTicked }}
          accessibilityLabel={policeConsent.text}
          testID="police-clearance-consent-tick"
          style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md, marginTop: -4, marginBottom: space.sm, paddingHorizontal: 4 }}
        >
          <BrandCheckbox checked={policeTicked} onToggle={() => setPoliceTicked((t) => !t)} label={policeConsent.text} />
          <T variant="micro" tone="muted" style={{ flex: 1 }}>{policeConsent.text}</T>
        </Pressable>
      ) : null}
      {/* [POLICE-CLEARANCE CONSENT] Withdraw at any time: the API's own words first. */}
      {policeConsent && status ? (
        <View style={{ alignSelf: 'flex-end', marginBottom: space.sm, paddingRight: 4 }}>
          <LinkText label="Withdraw my police clearance" tone="muted" onPress={confirmWithdraw} />
          {withdraw.isError ? (
            <T variant="micro" tone="error">
              {(withdraw.error as any)?.response?.data?.error?.message ?? 'Couldn’t withdraw it. Try again.'}
            </T>
          ) : null}
        </View>
      ) : null}
      {/* [E11] The contest door. Tap-to-re-upload fixes a BAD PHOTO; it cannot
          fix a decision — an insurance policy read as PRIVATE re-uploads to
          the same verdict, and 61 real applications sat stalled exactly there
          with no next action. The appeal rides the live support queue (every
          stack registers GetHelp since #798), prefilled with the document and
          the reviewer's own words, so a human re-reads the decision. */}
      {rejected ? (
        <View style={{ alignSelf: 'flex-end', marginTop: -4, marginBottom: space.sm, paddingRight: 4 }}>
          <LinkText
            label="Think this is wrong? Appeal it"
            tone="muted"
            onPress={() =>
              navigation?.navigate?.('GetHelp', {
                category: 'ACCOUNT',
                subject: `Appeal: ${label(docType)} was rejected`,
                message: reviewNote
                  ? `The rejection reason given was: "${reviewNote}". I believe this decision is wrong because `
                  : 'I believe this rejection is wrong because ',
              })
            }
          />
        </View>
      ) : null}
    </Pressable>
  );
}
