import type { ReactNode } from 'react';
import { pane } from '../theme/stone.ts';

// A container for components on the page. Nothing lies on the page without one: the stone of a pane is under it.
// className is for layout only, such as a margin.
export function Pane({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`${pane} ${className}`}>{children}</div>;
}
