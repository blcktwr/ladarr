import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { useState, type ReactElement, type ReactNode } from 'react';
import { modalSurface } from '../theme/stone.ts';
import { useModalRegistration } from './Alerts.tsx';
import { Actions } from './Actions.tsx';
import { Button } from './Button.tsx';

// The veil and the pane of a modal, and its widths. Each width stays 1rem inside each edge of a narrow screen. Confirm uses them too.
export const veil = 'fixed inset-0 bg-veil backdrop-blur-[2px] transition-opacity duration-200 ease-stone data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none';
export const popup = `${modalSurface} fixed top-1/2 left-1/2 -translate-1/2 box-border max-h-[calc(100dvh-2rem)] overflow-hidden outline-none transition-[opacity,scale] duration-200 ease-stone data-starting-style:opacity-0 data-starting-style:scale-95 data-ending-style:opacity-0 data-ending-style:scale-95 motion-reduce:transition-none`;
export const widths = { md: 'w-[min(36rem,calc(100vw-2rem))]', lg: 'w-[min(52rem,calc(100vw-2rem))]', xl: 'w-[min(62rem,calc(100vw-2rem))]' };

type ModalProps = Omit<Dialog.Root.Props, 'children' | 'modal'> & {
  // The button that opens the modal. Without it, open and onOpenChange control the modal.
  trigger?: ReactElement;
  title: string;
  // The title stays for a screen reader and does not show. Use it when the content says what the modal is.
  hideTitle?: boolean;
  // A row of buttons at the end. To close the modal from a button, set open to false in onClick.
  actions?: ReactNode;
  // md (the default) is 36rem. lg is 52rem, such as for a list with rows of buttons. xl is 62rem.
  width?: keyof typeof widths;
  children?: ReactNode;
};

// A pane in the center of the screen, over a veil on the whole app. While it is open, the page under it does not take clicks or keys.
// It has a title, a ghost close button, the content and a row of actions, with the spaces of a Section. Esc or a click on the veil closes it.
export function Modal({ trigger, title, hideTitle, actions, width = 'md', children, open, onOpenChange, ...props }: ModalProps) {
  // The dialog works with open, or by itself when a trigger opens it. Either way the alerts wait under it.
  const [showing, setShowing] = useState(false);
  useModalRegistration(open ?? showing);
  return (
    <Dialog.Root
      {...props}
      open={open}
      onOpenChange={(next, details) => {
        setShowing(next);
        onOpenChange?.(next, details);
      }}
    >
      {trigger && <Dialog.Trigger render={trigger} />}
      <Dialog.Portal>
        {/* A modal on top of another modal also has the veil. Base UI leaves it out for a nested dialog. */}
        <Dialog.Backdrop forceRender className={veil} />
        <Dialog.Popup className={`${popup} ${widths[width]}`}>
          <div className="flex items-center justify-between gap-4 w-full">
            <Dialog.Title className={hideTitle ? 'sr-only' : 'text-ink-strong text-[17px]/none font-semibold'}>{title}</Dialog.Title>
            <Dialog.Close render={<Button variant="ghost" iconOnly aria-label="Close" className={hideTitle ? 'ml-auto' : undefined} />}><X /></Dialog.Close>
          </div>
          <div className="-mx-6 grid grid-cols-[minmax(0,1fr)] justify-items-start min-h-0 flex-1 gap-5 overflow-x-hidden overflow-y-auto px-6">{children}</div>
          {actions && <Actions className="w-full justify-end">{actions}</Actions>}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
