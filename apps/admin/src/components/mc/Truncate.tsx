import type { CSSProperties, ElementType } from 'react';

/**
 * [MISSION CONTROL · PR-1] A long name on one line (or `lines` lines) with an
 * ellipsis, never a wrap mid-word or a column crushed sideways.
 *
 * The full text stays in the DOM (a screen reader reads all of it), in the
 * title (a mouse sees it on hover), and is shown in place when the element —
 * or the link it sits in — has keyboard focus. Pass `focusable` when it does
 * not sit inside a link or button, so a keyboard can reach it.
 */
export function Truncate({ text, lines, as: Tag = 'span', focusable = false, className = '' }: {
  text: string | null | undefined;
  lines?: number;
  as?: ElementType;
  focusable?: boolean;
  className?: string;
}) {
  const value = text ?? '';
  const style = lines && lines > 1 ? ({ '--mc-lines': lines } as CSSProperties) : undefined;
  return (
    <Tag
      className={`mc-truncate ${className}`}
      title={value}
      data-lines={lines && lines > 1 ? lines : undefined}
      style={style}
      tabIndex={focusable ? 0 : undefined}
    >
      {value}
    </Tag>
  );
}
