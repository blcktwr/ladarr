import { Slider as BaseSlider } from '@base-ui/react/slider';
import { off, on } from '../theme/stone.ts';

type SliderProps<Value extends number | readonly number[]> = Omit<BaseSlider.Root.Props<Value>, 'className' | 'children'> & {
  value: Value;
  // The name of each value, for a screen reader. An array has one name for each thumb.
  label: string | readonly string[];
  // The value as a person reads it, such as "No limit".
  valueText?: string | readonly (string | undefined)[];
  // The text inside each thumb.
  formatValue?: (value: number, index: number) => string;
  // The vertical distance between thumbs, when a range has more than one. 0 puts them on the track.
  stagger?: number;
  className?: string;
};

// A slider is a slot in the stone with a fill of the accent and a small round key that slides in it.
// A range has one thumb for each value. The thumbs stop at the ends of the slot, so they stay inside a narrow column.
// With stagger, the thumbs of a range sit at different heights, so each one stays visible when the values meet.
// className is for layout only, such as a width.
export function Slider<Value extends number | readonly number[]>({ value, label, valueText, formatValue, stagger = 0, className = '', thumbAlignment = 'edge', ...props }: SliderProps<Value>) {
  const values = (Array.isArray(value) ? value : [value]) as readonly number[];
  const nameOf = (index: number) => (Array.isArray(label) ? label[index] : label);
  const textOf = (index: number) => (Array.isArray(valueText) ? valueText[index] : index === 0 ? valueText : undefined);
  // A thumb is 20px high (h-5). A range grows taller for each thumb, so the stagger has room.
  const height = Math.max(48, 20 + (values.length - 1) * stagger);
  return (
    <BaseSlider.Root {...props} value={value} thumbAlignment={thumbAlignment} className={`data-disabled:opacity-35 ${className}`}>
      <BaseSlider.Control style={{ height }} className="flex w-full touch-none select-none items-center">
        <BaseSlider.Track className={`${off} relative h-2 w-full rounded-full`}>
          <BaseSlider.Indicator className={`${on} h-full rounded-full`} />
          {values.map((amount, index) => (
            <BaseSlider.Thumb
              key={index}
              index={index}
              aria-label={nameOf(index)}
              aria-valuetext={textOf(index)}
              style={{ top: `calc(50% + ${(index - (values.length - 1) / 2) * stagger}px)` }}
              className="flex h-5 min-w-6 items-center justify-center rounded-full bg-(image:--stone-lit) px-1 text-[10px]/none font-[550] text-ink shadow-(--thumb-edge) select-none has-[:focus-visible]:outline-solid has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-offset-2 data-disabled:cursor-not-allowed"
            >
              {formatValue && <span className="pointer-events-none">{formatValue(amount, index)}</span>}
            </BaseSlider.Thumb>
          ))}
        </BaseSlider.Track>
      </BaseSlider.Control>
    </BaseSlider.Root>
  );
}
