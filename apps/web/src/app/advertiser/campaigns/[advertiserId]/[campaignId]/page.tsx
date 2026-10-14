import { CampaignRead } from '@/components/advertiser-campaigns';
export default async function Page({ params }: { params: Promise<{ advertiserId: string; campaignId: string }> }) {
  const { advertiserId, campaignId } = await params;
  return <CampaignRead advertiserId={advertiserId} campaignId={campaignId} />;
}
