interface MetricCardProps {
  title: string;
  value: string;
  subtitle?: string;
  trend?: { value: number; label: string };
  loading?: boolean;
}

export function MetricCard({ title, value, subtitle, trend, loading }: MetricCardProps) {
  if (loading) {
    return (
      <div className="bg-[#1C1C1E] rounded-xl p-6 border border-[#38383A] animate-pulse">
        <div className="h-4 bg-[#2C2C2E] rounded w-24 mb-3" />
        <div className="h-8 bg-[#2C2C2E] rounded w-32" />
      </div>
    );
  }

  return (
    <div className="bg-[#1C1C1E] rounded-xl p-6 border border-[#38383A]">
      <p className="text-[#8E8E93] text-sm">{title}</p>
      <p className="text-3xl font-bold mt-1">{value}</p>
      {subtitle && <p className="text-[#8E8E93] text-xs mt-1">{subtitle}</p>}
      {trend && (
        <p className={`text-xs mt-2 ${trend.value >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {trend.value >= 0 ? '\u2191' : '\u2193'} {Math.abs(trend.value)}% {trend.label}
        </p>
      )}
    </div>
  );
}
