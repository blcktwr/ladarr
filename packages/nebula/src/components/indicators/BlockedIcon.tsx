import { Indicator } from './Indicator.tsx';

// An animated block icon: a bold warning triangle whose brightness breathes, because the state waits for a person.
export function BlockedIcon({ className }: { className?: string }) {
  return (
    <Indicator className={className}>
      <g className="animate-breathe motion-reduce:animate-none" strokeWidth={2.4}>
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </g>
    </Indicator>
  );
}
