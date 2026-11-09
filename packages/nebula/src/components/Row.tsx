import type { ReactNode } from 'react';
import { Actions } from './Actions.tsx';

type RowProps = { actions?: ReactNode; children: ReactNode };

// A row of a list. The text and the badges are at the start, and the actions are at the end.
// On a narrow screen the actions go below the text. A long word breaks, so the row stays inside its list.
export function Row({ actions, children }: RowProps) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 text-ink text-[15px] [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 min-w-0">{children}</div>
      {actions && <Actions>{actions}</Actions>}
    </li>
  );
}
