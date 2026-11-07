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
      <div className="mc-card animate-pulse" aria-busy="true">
        <div className="mb-3 h-3 w-24 rounded bg-[var(--mc-line)]" />
        <div className="h-7 w-32 rounded bg-[var(--mc-line)]" />
      </div>
    );
  }

  return (
    <div className="mc-card">
      <p className="mc-label">{title}</p>
      <p className="mc-stat-value mt-2">{value}</p>
      {subtitle && <p className="mc-stat-sub">{subtitle}</p>}
      {trend && (
        <p className={`mt-2 text-xs ${trend.value >= 0 ? 'mc-text-good' : 'mc-text-bad'}`}>
          {trend.value >= 0 ? '\u2191' : '\u2193'} {Math.abs(trend.value)}% {trend.label}
        </p>
      )}
    </div>
  );
}
