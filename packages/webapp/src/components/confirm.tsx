import { Button, Modal } from 'nebula';
import { useState, type ReactNode } from 'react';
import { t } from '../i18n/index.ts';
import { ModalActions } from './modal-actions.tsx';

type ConfirmProps = {
  // The label of the button that asks.
  label: string;
  // The question in the modal.
  title: string;
  // The label of the button that runs the action.
  confirm: string;
  onConfirm: () => void;
  disabled?: boolean;
  children?: ReactNode;
};

// The button opens a modal that asks again, and the action runs only after the second click.
export function Confirm({ label, title, confirm, onConfirm, disabled, children }: ConfirmProps) {
  const [open, setOpen] = useState(false);
  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      title={title}
      trigger={
        <Button variant="danger" disabled={disabled}>
          {label}
        </Button>
      }
    >
      {children}
      <ModalActions>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          {t('Cancel')}
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            setOpen(false);
            onConfirm();
          }}
        >
          {confirm}
        </Button>
      </ModalActions>
    </Modal>
  );
}
