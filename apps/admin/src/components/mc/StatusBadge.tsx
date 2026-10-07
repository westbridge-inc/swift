import { label, statusTone, type EnumName } from '@/lib/labels';

/** [MISSION CONTROL · PR-1] A status in plain words, coloured by what it means. Never the raw enum. */
export function StatusBadge({ group, value, className = '' }: { group: EnumName; value: string | null | undefined; className?: string }) {
  if (!value) return null;
  const tone = statusTone(group, value);
  return (
    <span className={`mc-badge${tone === 'neutral' ? '' : ` mc-tone-${tone}`} ${className}`} data-value={value}>
      {label(group, value)}
    </span>
  );
}
