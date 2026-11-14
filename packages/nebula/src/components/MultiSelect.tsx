import { Combobox } from '@base-ui/react/combobox';
import { Check, CircleAlert } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { flat, ghost, key, sunk } from '../theme/stone.ts';

const widths = { sm: 'w-32', md: 'w-80 max-w-full', full: 'w-full' };

export type MultiSelectOption = { value: string; label?: string; disabled?: boolean };

type MultiSelectProps = {
  label: string;
  value: string[];
  onValueChange: (value: string[]) => void;
  options: MultiSelectOption[];
  // The text in the field. It counts the selected values by default.
  valueText?: (count: number) => string;
  description?: string;
  error?: string;
  disabled?: boolean;
  width?: keyof typeof widths;
};

// A field that holds a list of options instead of a typed value. The field takes no text: a focus or a click opens the
// list, a click or Enter changes one option, and the field counts the options that are on. The list stays open, so a
// person sets the whole value in one visit.
export function MultiSelect({ label, value, onValueChange, options, valueText = (count) => `${count} selected`, description, error, disabled, width = 'md' }: MultiSelectProps) {
  const id = useId();
  const descriptionId = useId();
  const errorId = useId();
  const anchorRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const items = [...options.map((option) => option.value), ...value.filter((selected) => !options.some((option) => option.value === selected))];
  const textOf = (item: string) => options.find((option) => option.value === item)?.label ?? item;

  return (
    <div className={`grid gap-2 ${widths[width]}`}>
      <label htmlFor={id} className="text-ink text-[13px]/none font-[550]">
        {label}
      </label>
      <Combobox.Root
        multiple
        items={items}
        value={value}
        onValueChange={(next) => onValueChange(next)}
        open={open}
        onOpenChange={(next, details) => {
          // A press on an item changes the value. In multiple mode, the list stays open for the next item.
          if (!next && details.reason === 'item-press') return;
          setOpen(next);
        }}
        inputValue={valueText(value.length)}
        filter={null}
        disabled={disabled}
      >
        <Combobox.Input
          id={id}
          ref={anchorRef}
          readOnly
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          aria-describedby={[description ? descriptionId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined}
          aria-invalid={Boolean(error)}
          data-invalid={error ? '' : undefined}
          data-disabled={disabled ? '' : undefined}
          className={`${flat} w-full min-w-0 px-3.5 text-[15px]/none cursor-pointer`}
        />
        <Combobox.Portal>
          <Combobox.Positioner anchor={anchorRef} align="start" sideOffset={8}>
            <Combobox.Popup className="box-border min-w-(--anchor-width) max-h-[min(15rem,var(--available-height))] overflow-y-auto overscroll-contain p-1 rounded-lg outline-none bg-(image:--grain) bg-slab shadow-(--slab-shadow) text-ink">
              <Combobox.List>
                {(item: string) => {
                  const option = options.find((candidate) => candidate.value === item);
                  return (
                    <Combobox.Item
                      key={item}
                      value={item}
                      disabled={option?.disabled}
                      className={({ selected }) => `${key} ${selected ? sunk : ghost} group flex items-center justify-between gap-6 w-full h-10 px-3 rounded-[5px] cursor-pointer data-disabled:opacity-35 data-disabled:cursor-not-allowed`}
                    >
                      <span>{textOf(item)}</span>
                      <Combobox.ItemIndicator keepMounted className="flex text-accent invisible group-data-selected:visible [&>svg]:size-4">
                        <Check />
                      </Combobox.ItemIndicator>
                    </Combobox.Item>
                  );
                }}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
      {description && (
        <p id={descriptionId} className="text-fog text-[13px]/4">
          {description}
        </p>
      )}
      <div className="grid min-h-3.5">
        {error && (
          <p id={errorId} className="flex items-center gap-1.5 min-h-4 -mt-0.5 text-error text-[13px]/4 font-medium">
            <CircleAlert className="size-3.5 shrink-0" />
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
