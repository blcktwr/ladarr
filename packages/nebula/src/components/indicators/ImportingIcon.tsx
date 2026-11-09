import { Indicator } from './Indicator.tsx';

// An animated import icon: an arrow goes into the box through the gap in its side, and then the gap closes.
export function ImportingIcon({ className }: { className?: string }) {
  return (
    <Indicator className={className}>
      <path d="M7.5 8.7V7.5a2 2 0 0 1 2-2h9.5a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9.5a2 2 0 0 1-2-2v-1.2" />
      <path d="M7.5 8.7v6.6" className="opacity-0 animate-seal motion-reduce:animate-none" />
      <g className="animate-enter motion-reduce:animate-none" strokeWidth={2.25}>
        <path d="M1.5 12h8" />
        <path d="m5.9 9.4 3.6 2.6-3.6 2.6" />
      </g>
    </Indicator>
  );
}
