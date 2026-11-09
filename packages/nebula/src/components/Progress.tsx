import { off, on } from '../theme/stone.ts';

type ProgressProps = {
  // How much is done, from 0 to 100.
  value: number;
  // The name of the task, for a screen reader.
  label: string;
  className?: string;
};

// A thin bar that shows how much of a known task is done: a slot in the stone, and a fill of the accent.
// The bar is 6px high, so it fits in a row of a table. className is for layout only, such as a width.
export function Progress({ value, label, className = '' }: ProgressProps) {
  const percent = Math.min(100, Math.max(0, Math.round(value)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={`${off} box-border w-full h-1.5 rounded-full overflow-hidden ${className}`}
    >
      <div className={`${on} h-full rounded-full`} style={{ width: `${percent}%` }} />
    </div>
  );
}
