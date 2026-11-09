import { Actions } from 'nebula';
import type { ReactNode } from 'react';

// The buttons of a modal at the right edge. It stays at the bottom of the content while that content scrolls.
// Put it as the last child of the modal.
export function ModalActions({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 -mx-6 -mt-5 justify-self-stretch bg-(image:--grain) bg-pane px-6 pt-5 pb-5">
      <Actions className="w-full justify-end">{children}</Actions>
    </div>
  );
}
