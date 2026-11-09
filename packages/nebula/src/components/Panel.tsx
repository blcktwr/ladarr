import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { createContext, useContext, useState, type ReactElement, type ReactNode } from 'react';
import { Button } from './Button.tsx';
import { useModalRegistration } from './Alerts.tsx';
import { veil } from './Modal.tsx';
import { Text } from './Text.tsx';

// The widths of the panel. Each one stays inside the window.
const widths = { md: '22.5rem', lg: '45%', xl: '50%' };

// A panel that opens over another one takes 95% of the width of the panel under it, so a band of that panel stays
// visible on the left. The width of the first panel of the stack comes from its size.
const share = 0.95;
const stack = createContext<{ width: string; depth: number } | null>(null);

type PanelProps = Omit<Dialog.Root.Props, 'children' | 'modal'> & {
  // The button that opens the panel. Without it, open and onOpenChange control the panel.
  trigger?: ReactElement;
  label: string;
  // The name of the panel, in the same row as the close button.
  title?: ReactNode;
  // md (the default) is 360px. lg is 45% of the window and xl is half of it, such as for a long content. A panel that
  // opens over another one ignores this size and takes its width from the panel under it.
  size?: keyof typeof widths;
  children?: ReactNode;
};

// A side panel is a slab of stone along the right edge of the screen, over the veil of a modal. Esc or a click on the
// veil closes it. trigger is the button that opens it; label names both.
export function Panel({ trigger, label, title, size = 'md', children, open, onOpenChange, ...props }: PanelProps) {
  // The dialog works with open, or by itself when a trigger opens it. Either way the alerts wait under it.
  const [showing, setShowing] = useState(false);
  useModalRegistration(open ?? showing);
  const parent = useContext(stack);
  const depth = (parent?.depth ?? -1) + 1;
  const base = parent?.width ?? widths[size];
  const width = depth === 0 ? base : `calc(${base} * ${share ** depth})`;
  return (
    <stack.Provider value={{ width: base, depth }}>
      <Dialog.Root
        {...props}
        modal
        open={open}
        onOpenChange={(next, details) => {
          setShowing(next);
          onOpenChange?.(next, details);
        }}
      >
        {trigger && <Dialog.Trigger render={trigger} aria-label={label} />}
        <Dialog.Portal>
          <Dialog.Backdrop className={veil} />
          <Dialog.Popup aria-label={label} style={{ width }} className="fixed inset-y-0 right-0 box-border flex flex-col gap-4 max-w-full overflow-y-auto p-4 outline-none bg-(image:--grain) bg-slab shadow-(--panel-shadow) text-ink">
            <div className="flex items-center gap-4">
              {title !== undefined && <Text variant="heading" className="min-w-0">{title}</Text>}
              <Dialog.Close className="ml-auto shrink-0" render={<Button variant="ghost" iconOnly aria-label="Close" />}><X /></Dialog.Close>
            </div>
            {children}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </stack.Provider>
  );
}
