import { useId, type ReactNode } from 'react';
import { Actions } from './Actions.tsx';

// action is a control at the right of the title, such as a Button that adds an item. It shows also when the content is an EmptyState.
type SectionProps = { title: string; action?: ReactNode; actions?: ReactNode; children?: ReactNode };

// A part of a page, with no box: a title, the content, and a row of actions at the end. It lies on a pane.
export function Section({ title, action, actions, children }: SectionProps) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid grid-cols-[minmax(0,1fr)] justify-items-start gap-5 w-full">
      {/* As in Table: on a narrow screen, the control goes below the title, at the right. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 w-full">
        <h2 id={id} className="text-ink-strong text-[17px]/none font-semibold">{title}</h2>
        {action && <div className="ml-auto"><Actions>{action}</Actions></div>}
      </div>
      {children}
      {actions && <Actions>{actions}</Actions>}
    </section>
  );
}
