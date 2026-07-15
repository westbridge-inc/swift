'use client';

import { use } from 'react';
import { MoverDetail } from '@/components/MoverDetail';

export default function RiderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <MoverDetail id={id} kind="rider" />;
}
