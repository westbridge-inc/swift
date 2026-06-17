import { View } from 'react-native';
import { Text, Heading } from '../ui';
import { DocumentUploadCard } from './DocumentUploadCard';

/** Renders GET /verification/status?role= as the "Required steps" checklist. */
export function DocumentChecklist({ role, status }: { role: string; status: any }) {
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
    return <Text className="text-text-secondary">No documents required for your region yet.</Text>;
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
