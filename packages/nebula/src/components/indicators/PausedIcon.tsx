import { Indicator } from './Indicator.tsx';

// Two bars that settle into place when the target pauses, and then stay still.
export function PausedIcon({ className }: { className?: string }) {
  return (
    <Indicator className={className}>
      <g className="animate-settle motion-reduce:animate-none">
        <path d="M9 5v14" />
        <path d="M15 5v14" />
      </g>
    </Indicator>
  );
}
