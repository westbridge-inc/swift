import { View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { EmptyState, Spinner, T } from '../../kit';
import { DocumentUploadCard } from './DocumentUploadCard';

/**
 * Renders GET /verification/status?role= as the "Required steps" checklist.
 * Honest about every state — a failed/loading request is NOT silently shown as
 * "no documents required" (which previously masked a 500 behind an "upload your
 * documents" banner). Pass the query's `isLoading`/`isError`/`onRetry` so the
 * screen can't contradict itself.
 */
export function DocumentChecklist({
  role,
  status,
  isLoading,
  isError,
  onRetry,
}: {
  role: string;
  status: any;
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
}) {
  if (isLoading) {
    return (
      <View className="items-center justify-center py-2xl">
        <Spinner />
      </View>
    );
  }

  if (isError) {
    return (
      <EmptyState
        icon="alert-circle"
        title="Couldn’t load your verification steps"
        body="We couldn’t reach the server. Check your connection and try again."
        actionLabel={onRetry ? 'Retry' : undefined}
        onAction={onRetry}
      />
    );
  }

  const checklist: string[] = status?.checklist ?? [];
  const documents: any[] = status?.documents ?? [];

  const latestDoc = (docType: string) => {
    const docs = documents
      .filter((d) => d.docType === docType)
      .sort((a, b) => (String(a.createdAt) < String(b.createdAt) ? 1 : -1));
    // Precedence: an in-flight renewal shows as pending; else the current
    // approved document (with its expiry); else the newest row (expired/
    // rejected) which re-opens the upload.
    return (
      docs.find((d) => d.status === 'PENDING')
      ?? docs.find((d) => d.status === 'APPROVED' && (!d.expiresAt || new Date(d.expiresAt) > new Date()))
      ?? docs[0]
    );
  };

  const nextDoc = checklist.find((dt) => latestDoc(dt)?.status !== 'APPROVED');

  if (checklist.length === 0) {
    return (
      <EmptyState
        icon="shield"
        title="You’re all set for now"
        body="Your account is under review — we’ll approve within 24 hours. Nothing else is needed from you right now."
      />
    );
  }

  const approvedCount = checklist.filter((dt) => latestDoc(dt)?.status === 'APPROVED').length;
  const allSubmitted = checklist.every((dt) => ['APPROVED', 'PENDING'].includes(latestDoc(dt)?.status));

  return (
    <View>
      <T variant="heading" style={{ marginBottom: space.xs }}>
        Required steps
      </T>
      <T variant="label" tone="muted" style={{ marginBottom: space.sm }}>
        Upload these to activate your account. We review within 24 hours.
      </T>
      {/* Progress — how far through the door they are */}
      <View className="mb-md">
        <View className="mb-1 flex-row items-center justify-between">
          <T variant="micro" weight="semibold" tone="muted">
            {approvedCount} of {checklist.length} approved
          </T>
          {allSubmitted && approvedCount < checklist.length ? (
            <T variant="micro" weight="semibold" style={{ color: color.brand[500] }}>
              All submitted — in review
            </T>
          ) : null}
        </View>
        <View className="h-1.5 overflow-hidden rounded-full" style={{ backgroundColor: color.surface.subtle }}>
          <View
            className="h-1.5 rounded-full"
            style={{ width: `${Math.round((approvedCount / checklist.length) * 100)}%`, backgroundColor: color.success }}
          />
        </View>
      </View>
      {checklist.map((docType) => {
        const doc = latestDoc(docType);
        return (
          <DocumentUploadCard
            key={docType}
            role={role}
            docType={docType}
            status={doc?.status}
            expiresAt={doc?.status === 'APPROVED' ? doc?.expiresAt : null}
            submittedAt={doc?.createdAt ?? null}
            reviewNote={doc?.reviewNote ?? null}
            isNext={docType === nextDoc}
          />
        );
      })}
      <View className="mt-sm flex-row items-start rounded-2xl bg-surface-subtle p-md">
        <MaterialCommunityIcons name="shield-check-outline" size={16} color={color.text.muted} style={{ marginTop: 1 }} />
        <T variant="micro" tone="muted" style={{ marginLeft: space.sm, flex: 1 }}>
          We confirm your documents are genuine and that they&apos;re yours, and re‑check expiry every day — we&apos;ll
          remind you before anything lapses so you stay verified.
        </T>
      </View>
    </View>
  );
}
