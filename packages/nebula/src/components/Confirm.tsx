import { AlertDialog } from '@base-ui/react/alert-dialog';
import { useRef } from 'react';
import type { ReactNode } from 'react';
import { Actions } from './Actions.tsx';
import { useModalRegistration } from './Alerts.tsx';
import { Button } from './Button.tsx';
import { popup, veil, widths } from './Modal.tsx';

type ConfirmProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // The question, such as "Remove 1 title?".
  title: string;
  // The label of the confirm button, such as "Remove".
  confirm: string;
  // It does not close the alert. Set open to false when the action ends.
  onConfirm: () => void;
  // The action runs: the confirm button shows a wheel.
  pending?: boolean;
  disabled?: boolean;
  children?: ReactNode;
};

// An alert that asks before an action that destroys data. It is a Modal with no trigger and no close button: the page opens it.
// A screen reader reads the title and the content at once. The Cancel button has the focus when it opens, so Enter does not destroy data.
// Cancel or Esc closes it. A click on the veil does not.
export function Confirm({ open, onOpenChange, title, confirm, onConfirm, pending, disabled, children }: ConfirmProps) {
  const cancel = useRef<HTMLButtonElement>(null);
  // The alerts wait under the question, so it keeps its buttons.
  useModalRegistration(open);
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={veil} />
        <AlertDialog.Popup initialFocus={cancel} className={`${popup} ${widths.md}`}>
          <AlertDialog.Title className="text-ink-strong text-[17px]/6 font-semibold">{title}</AlertDialog.Title>
          {children && <AlertDialog.Description render={<div />} className="grid grid-cols-[minmax(0,1fr)] justify-items-start min-h-0 w-full gap-5 overflow-y-auto text-ink text-[15px]/6">{children}</AlertDialog.Description>}
          {/* The buttons are at the right edge. The confirm button is last, at the far right. */}
          <div className="self-end shrink-0">
            <Actions>
              <AlertDialog.Close ref={cancel} render={<Button variant="ghost" />}>Cancel</AlertDialog.Close>
              <Button variant="danger" pending={pending} disabled={disabled} onClick={onConfirm}>{confirm}</Button>
            </Actions>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
