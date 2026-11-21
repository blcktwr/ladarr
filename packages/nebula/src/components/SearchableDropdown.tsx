import { Combobox } from '@base-ui/react/combobox';
import { Check } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { flat, ghost, key, sunk } from '../theme/stone.ts';

const widths = { sm: 'w-32', md: 'w-80 max-w-full', full: 'w-full' };

type SearchableDropdownProps = {
  label: string;
  hideLabel?: boolean;
  disabled?: boolean;
  placeholder?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label?: string; disabled?: boolean }[];
  emptyText?: string;
  width?: keyof typeof widths;
};

export function SearchableDropdown({ label, hideLabel, disabled, placeholder, value, onValueChange, options, emptyText = 'No options.', width = 'md' }: SearchableDropdownProps) {
  const id = useId();
  const anchorRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const items = options.map((option) => option.value);
  const textOf = (item: string) => options.find((option) => option.value === item)?.label ?? item;

  return (
    <div className={`grid min-w-0 gap-2 ${widths[width]}`}>
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'text-ink text-[13px]/none font-[550]'}>
        {label}
      </label>
      <Combobox.Root
        items={items}
        value={value || null}
        onValueChange={(next, details) => {
          if (details.reason === 'escape-key') details.allowPropagation();
          onValueChange(next ?? '');
        }}
        itemToStringLabel={textOf}
        disabled={disabled}
        open={open && !disabled}
        onOpenChange={setOpen}
      >
        <Combobox.Input
          id={id}
          ref={anchorRef}
          placeholder={placeholder}
          title={value ? textOf(value) : undefined}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          className={`${flat} w-full min-w-0 px-3.5 text-[15px]/none text-ellipsis`}
        />
        <Combobox.Portal>
          <Combobox.Positioner anchor={anchorRef} align="start" sideOffset={8}>
            <Combobox.Popup className="box-border w-(--anchor-width) max-h-[min(15rem,var(--available-height))] overflow-y-auto overscroll-contain p-1 rounded-lg outline-none bg-(image:--grain) bg-slab shadow-(--slab-shadow) text-ink">
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
                      <span className="truncate" title={textOf(item)}>{textOf(item)}</span>
                      <Combobox.ItemIndicator keepMounted className="flex shrink-0 text-accent invisible group-data-selected:visible [&>svg]:size-4">
                        <Check />
                      </Combobox.ItemIndicator>
                    </Combobox.Item>
                  );
                }}
              </Combobox.List>
              <Combobox.Empty className="px-3 py-2 text-fog text-[13px]/4 empty:hidden">{emptyText}</Combobox.Empty>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
    </div>
  );
}
