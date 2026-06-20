'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchConfig } from '@/lib/api';

export default function ConfigPage() {
  const { data, isLoading } = useQuery({ queryKey: ['config'], queryFn: fetchConfig });

  const configSections = [
    {
      title: 'Delivery Settings',
      items: [
        { key: 'deliveryRadiusKm', label: 'Delivery Radius (km)', type: 'number' },
        { key: 'maxDeliveryTimeMin', label: 'Max Delivery Time (min)', type: 'number' },
        { key: 'baseSurgeMultiplier', label: 'Base Surge Multiplier', type: 'number' },
      ],
    },
    {
      title: 'Pricing',
      items: [
        { key: 'markupPercentage', label: 'Default Markup (%)', type: 'number' },
        { key: 'deliveryFeeBase', label: 'Base Delivery Fee (GYD)', type: 'number' },
        { key: 'deliveryFeePerKm', label: 'Per-KM Fee (GYD)', type: 'number' },
      ],
    },
    {
      title: 'Subscriptions (Weekly GYD)',
      items: [
        { key: 'subscriptionDeliveryRider', label: 'Delivery Rider', type: 'number' },
        { key: 'subscriptionCourierRider', label: 'Courier Rider', type: 'number' },
        { key: 'subscriptionTaxiDriver', label: 'Taxi Driver', type: 'number' },
        { key: 'subscriptionRestaurant', label: 'Restaurant', type: 'number' },
        { key: 'subscriptionSupermarket', label: 'Supermarket', type: 'number' },
      ],
    },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Platform Configuration</h1>

      {isLoading ? (
        <div className="bg-[#1C1C1E] rounded-xl border border-[#38383A] p-8 text-center text-[#8E8E93]">
          Loading configuration...
        </div>
      ) : (
        <div className="space-y-6">
          {configSections.map((section) => (
            <div key={section.title} className="bg-[#1C1C1E] rounded-xl border border-[#38383A] p-6">
              <h2 className="text-lg font-semibold mb-4">{section.title}</h2>
              <div className="space-y-3">
                {section.items.map((item) => (
                  <div key={item.key} className="flex items-center justify-between p-3 rounded-lg bg-white/5">
                    <label className="text-sm">{item.label}</label>
                    <input
                      type={item.type}
                      defaultValue={data?.data?.[item.key] ?? ''}
                      className="bg-[#2C2C2E] text-white px-3 py-1.5 rounded-lg text-sm border border-[#38383A] focus:border-[#E8192C] focus:outline-none w-32 text-right"
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div className="flex justify-end">
            <button className="px-6 py-2.5 bg-[#E8192C] text-white rounded-lg text-sm font-medium hover:bg-[#E8192C]/80">
              Save Configuration
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
