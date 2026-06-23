import { View } from 'react-native';
import { Text, Heading, Spinner, EmptyState } from '../ui';
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
        icon="alert-circle-outline"
        title="Couldn’t load your verification steps"
        body="We couldn’t reach the server. Check your connection and try again."
        actionLabel={onRetry ? 'Retry' : undefined}
        onAction={onRetry}
      />
    );
  }

  const checklist: string[] = status?.checklist ?? [];
  const documents: any[] = status?.documents ?? [];

  const latestStatus = (docType: string): 'APPROVED' | 'PENDING' | 'REJECTED' | undefined => {
    const docs = documents
      .filter((d) => d.docType === docType)
      .sort((a, b) => (String(a.createdAt) < String(b.createdAt) ? 1 : -1));
    return docs[0]?.status;
  };

  const nextDoc = checklist.find((dt) => latestStatus(dt) !== 'APPROVED');

  if (checklist.length === 0) {
    return (
      <EmptyState
        icon="shield-check-outline"
        title="You’re all set for now"
        body="Your account is under review — we’ll approve within 24 hours. Nothing else is needed from you right now."
      />
    );
  }

  return (
    <View>
      <Heading size="lg" className="mb-xs">
        Required steps
      </Heading>
      <Text className="mb-md text-sm text-text-secondary">
        Upload these to activate your account. We review within 24 hours.
      </Text>
      {checklist.map((docType) => (
        <DocumentUploadCard
          key={docType}
          role={role}
          docType={docType}
          status={latestStatus(docType)}
          isNext={docType === nextDoc}
        />
      ))}
    </View>
  );
}
