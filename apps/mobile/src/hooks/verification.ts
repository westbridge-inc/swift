import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { verificationApi, partnerApi } from '../services/api';

const PRIVACY_NOTICE_VERSION = 'v1';

async function unwrap<T = any>(p: Promise<any>): Promise<T> {
  const r = await p;
  return r?.data?.data as T;
}

export function useVerificationStatus<T = any>(role: string, vehicleType?: string) {
  return useQuery<T>({
    queryKey: ['verification', role, vehicleType],
    queryFn: () => unwrap<T>(verificationApi.status(role, vehicleType)),
  });
}

export function useBecomePartner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      role: 'MOVER' | 'VENDOR';
      vehicleType?: 'BICYCLE' | 'MOTORCYCLE' | 'CAR';
      vehicle?: { make: string; model: string; year: number; color: string; licensePlate: string };
      business?: {
        name: string;
        vendorType: 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE';
        phone: string;
        addressLine1: string;
        city: string;
        region?: string;
        latitude: number;
        longitude: number;
      };
    }) => unwrap(partnerApi.become(data)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['verification'] });
      qc.invalidateQueries({ queryKey: ['vendor'] });
      qc.invalidateQueries({ queryKey: ['mover'] });
    },
  });
}

/** Upload a single picked file to storage; resolves to its fileUrl. */
export function useUploadFile() {
  return useMutation({
    mutationFn: async (file: { uri: string; name: string; type: string }) => {
      const form = new FormData();
      form.append('file', { uri: file.uri, name: file.name, type: file.type } as any);
      const up = await unwrap<{ url: string }>(verificationApi.upload(form));
      return up.url;
    },
  });
}

/** Consumer L2: submit a government ID + selfie (manual KYC review). */
export function useSubmitIdentity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { idDocumentUrl: string; selfieUrl: string }) =>
      unwrap(verificationApi.submitIdentity({ ...data, consent: true, privacyNoticeVersion: PRIVACY_NOTICE_VERSION })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['verification'] }),
  });
}

/** Upload a picked file to storage, then submit it as a checklist document. */
export function useUploadDocument(role: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ docType, file }: { docType: string; file: { uri: string; name: string; type: string } }) => {
      const form = new FormData();
      form.append('file', { uri: file.uri, name: file.name, type: file.type } as any);
      const uploaded = await unwrap<{ url: string }>(verificationApi.upload(form));
      return unwrap(
        verificationApi.submitDocument({
          role,
          docType,
          fileUrl: uploaded.url,
          consent: true,
          privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
        }),
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['verification', role] }),
  });
}
