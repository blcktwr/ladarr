import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { key, off, on, toggle } from '../theme/stone.ts';

// deactivated is off, and a line strikes out the checkbox and its label.
type CheckboxProps = Omit<BaseCheckbox.Root.Props, 'className' | 'children'> & { label?: ReactNode; deactivated?: boolean };

// A checkbox is a small slot in the stone. Checking it makes it a key of the accent with a check, which grows in and shrinks out.
export function Checkbox({ label, deactivated, disabled, ...props }: CheckboxProps) {
  return (
    <label className={toggle}>
      <BaseCheckbox.Root
        {...props}
        disabled={disabled || deactivated}
        data-deactivated={deactivated || undefined}
        className={({ checked, disabled }) => `${key} ${checked && !disabled ? on : off} inline-flex items-center justify-center size-8 rounded-md cursor-[inherit] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-3`}
      >
        {/* On an enabled key the check takes the colour of the page. */}
        <BaseCheckbox.Indicator className="flex text-night data-disabled:text-accent transition-[scale] duration-150 ease-stone data-starting-style:scale-0 data-ending-style:scale-0 [&>svg]:size-5 [&>svg]:stroke-3">
          <Check />
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
      {label}
    </label>
  );
}
