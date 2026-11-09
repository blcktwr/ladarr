import { wheel } from '../theme/stone.ts';

const sizes = { sm: 'size-4', md: 'size-6', lg: 'size-12' };

type SpinnerProps = { label: string; size?: keyof typeof sizes };

// A wheel that turns while something loads. A screen reader reads the label.
export function Spinner({ label, size = 'md' }: SpinnerProps) {
  return <span role="status" aria-label={label} className={`${wheel} ${sizes[size]} inline-block`} />;
}
