import type { ReactNode } from 'react';

// A message in the center, for a list or a table with no rows.
export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="grid place-items-center w-full min-h-24 px-4 py-6 text-fog text-[15px] text-center">{children}</p>;
}
