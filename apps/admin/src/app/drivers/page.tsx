'use client';

import { useQuery } from '@tanstack/react-query';

export default function DriversPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['drivers'],
    queryFn: async () => {
      const token = typeof window !== 'undefined' ? localStorage.getItem('swift_admin_token') : null;
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'}/api/v1/admin/drivers`, {
        headers: { ...(token && { Authorization: `Bearer ${token}` }) },
      });
      if (!res.ok) throw new Error('Failed to fetch drivers');
      return res.json();
    },
  });

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Drivers</h1>
      <div className="bg-[#1C1C1E] rounded-xl border border-[#38383A] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#38383A]">
              <th className="text-left p-4 text-[#8E8E93] font-medium">Name</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Phone</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Vehicle</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Status</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Documents</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Rating</th>
              <th className="text-right p-4 text-[#8E8E93] font-medium">Total Trips</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} className="p-8 text-center text-[#8E8E93]">Loading...</td></tr>
            ) : data?.data?.length === 0 ? (
              <tr><td colSpan={7} className="p-8 text-center text-[#8E8E93]">No drivers found</td></tr>
            ) : (
              data?.data?.map((driver: any) => (
                <tr key={driver.id} className="border-b border-[#38383A] hover:bg-white/5">
                  <td className="p-4 font-medium">{driver.user?.firstName} {driver.user?.lastName}</td>
                  <td className="p-4">{driver.user?.phone || '\u2014'}</td>
                  <td className="p-4">{driver.vehicleMake} {driver.vehicleModel}</td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded-full text-xs ${
                      driver.isOnline ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400'
                    }`}>{driver.isOnline ? 'Online' : 'Offline'}</span>
                  </td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded-full text-xs ${
                      driver.documentsVerified ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-400'
                    }`}>{driver.documentsVerified ? 'Verified' : 'Pending'}</span>
                  </td>
                  <td className="p-4">{driver.averageRating?.toFixed(1) || '\u2014'}</td>
                  <td className="p-4 text-right">{driver.totalTrips || 0}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
