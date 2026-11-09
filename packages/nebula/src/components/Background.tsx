import type { ReactNode } from 'react';

type BackgroundProps = { children?: ReactNode };

// The page under everything: near-black with haze, as --backdrop sets it for the theme. It fills the screen at least.
// The haze is on a fixed layer with the size of the window, so it does not stretch or move with the height of the content.
export function Background({ children }: BackgroundProps) {
  return (
    <div className="isolate min-h-screen">
      <div aria-hidden="true" className="fixed inset-0 -z-10 bg-(image:--backdrop)" />
      {children}
    </div>
  );
}
