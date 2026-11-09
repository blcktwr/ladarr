import { Indicator } from './Indicator.tsx';

// An animated hourglass: one grain of sand falls from the top bulb to the bottom one, then the glass turns over.
// The glass has the same shape after half a turn, so the next cycle starts without a jump.
export function WaitingIcon({ className }: { className?: string }) {
  return (
    <Indicator className={className}>
      <g className="origin-center animate-flip motion-reduce:animate-none">
        <path d="M5 2h14" />
        <path d="M5 22h14" />
        <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" />
        <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />
      </g>
      <circle cx="12" cy="6.5" r="1" fill="currentColor" stroke="none" className="animate-fall motion-reduce:animate-none" />
    </Indicator>
  );
}
