import type { ReactNode } from 'react';

// The frame of a state icon: one viewBox, one stroke, and the colour of the text.
// An indicator only draws its own parts, so every state keeps the same weight and size.
export function Indicator({ children, className = 'size-4.5' }: { children: ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      {children}
    </svg>
  );
}
