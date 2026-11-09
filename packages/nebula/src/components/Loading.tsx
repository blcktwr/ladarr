import type { ReactNode } from 'react';
import { Spinner } from './Spinner.tsx';

type LoadingProps = {
  // The content loads, such as during a search: a veil covers it, and a large spinner turns in its center.
  active?: boolean;
  label: string;
  children: ReactNode;
};

// Put it around the content of the app, but not around the navbar. Thus the navbar stays free while the content loads.
// While the veil shows, the content under it does not take clicks or keys. A screen reader reads the label.
// The spinner stays in the center of the part of the content that is on the screen.
export function Loading({ active, label, children }: LoadingProps) {
  return (
    <div aria-busy={active || undefined} className="relative">
      <div inert={active}>{children}</div>
      {active && (
        <div className="absolute inset-0 bg-veil backdrop-blur-[2px] transition-opacity duration-200 ease-stone starting:opacity-0 motion-reduce:transition-none">
          <div className="sticky top-0 grid place-items-center h-dvh max-h-full">
            <Spinner label={label} size="lg" />
          </div>
        </div>
      )}
    </div>
  );
}
