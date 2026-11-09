import { Tooltip } from '@base-ui/react/tooltip';
import { CircleHelp } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { ghost, key } from '../theme/stone.ts';

// label is the accessible name of the button, such as "About 2160p". children is a short text.
type HintProps = { label: string; children: ReactNode };

// A small round ghost key with the help icon, that shows a short text in a slab, as the list of an ActionMenu.
// The text shows when the pointer is on the key, when the key gets the focus from the keyboard, or after a click, such as a tap on a touch screen. Esc closes it.
// It is a tooltip and not a popover, so the Tab key goes past it to the next control.
// The text stays in the page while it is closed, so a screen reader reads it as the description of the key.
export function Hint({ label, children }: HintProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <Tooltip.Root open={open} onOpenChange={setOpen}>
      <Tooltip.Trigger
        delay={300}
        closeOnClick={false}
        aria-label={label}
        aria-describedby={id}
        onClick={() => setOpen(true)}
        className={`${key} ${ghost} inline-grid place-items-center size-7 rounded-full align-middle cursor-pointer [&>svg]:size-4 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2`}
      >
        <CircleHelp />
      </Tooltip.Trigger>
      <Tooltip.Portal keepMounted>
        <Tooltip.Positioner sideOffset={6}>
          <Tooltip.Popup id={id} className="box-border max-w-72 px-3 py-2 rounded-lg outline-none bg-(image:--grain) bg-slab shadow-(--slab-shadow) text-ink text-[13px]/5">
            {children}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
