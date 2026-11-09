import { Switch as BaseSwitch } from '@base-ui/react/switch';
import type { ReactNode } from 'react';
import { key, off, on, toggle } from '../theme/stone.ts';

// A switch has no pressed look, so it takes the pressed states out of the materials. Checkbox keeps them.
const still = (look: string) => look.split(' ').filter(name => !name.startsWith('pressed:')).join(' ');
const looks = { key: still(key), on: still(on), off: still(off) };

// deactivated is off, and a line strikes out the switch and its label.
type SwitchProps = Omit<BaseSwitch.Root.Props, 'className' | 'children'> & { label?: ReactNode; deactivated?: boolean };

// A switch is a wide slot in the stone with a small key in it. Turning it on slides the small key to the end,
// and the slot becomes a key of the accent, as a checked checkbox does. The small key is always lit stone.
export function Switch({ label, deactivated, disabled, ...props }: SwitchProps) {
  return (
    <label className={toggle}>
      <BaseSwitch.Root
        {...props}
        disabled={disabled || deactivated}
        data-deactivated={deactivated || undefined}
        className={({ checked, disabled }) => `${looks.key} ${checked && !disabled ? looks.on : looks.off} relative inline-flex items-center justify-center w-15 h-8 rounded-2xl cursor-[inherit] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2`}
      >
        <BaseSwitch.Thumb className="absolute top-0.75 left-1.25 size-5.5 rounded-full bg-(image:--stone-lit) shadow-(--thumb-edge) transition-[translate] duration-200 ease-stone data-checked:translate-x-7" />
      </BaseSwitch.Root>
      {label}
    </label>
  );
}
