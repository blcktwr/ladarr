import { Slider as BaseSlider } from '@base-ui/react/slider';
import { off, on } from '../theme/stone.ts';

type SliderProps<Value extends number | readonly number[]> = Omit<BaseSlider.Root.Props<Value>, 'className' | 'children'> & {
  value: Value;
  // The name of each value, for a screen reader. An array has one name for each thumb.
  label: string | readonly string[];
  // The value as a person reads it, such as "No limit".
  valueText?: string | readonly (string | undefined)[];
  // The text next to each mark.
  formatValue?: (value: number, index: number) => string;
  // The vertical distance between the hit areas of a range.
  stagger?: number;
  className?: string;
};

// A slider is a slot in the stone with a fill of the accent and a vertical mark at each value.
// The marks stay on the track, even when stagger separates their hit areas.
// className is for layout only, such as a width.
export function Slider<Value extends number | readonly number[]>({ value, label, valueText, formatValue, stagger = 0, className = '', thumbAlignment = 'center', ...props }: SliderProps<Value>) {
  const values = (Array.isArray(value) ? value : [value]) as readonly number[];
  const nameOf = (index: number) => (Array.isArray(label) ? label[index] : label);
  const textOf = (index: number) => (Array.isArray(valueText) ? valueText[index] : index === 0 ? valueText : undefined);
  const spread = (values.length - 1) * stagger;
  const splitLabels = values.length === 2;
  const labelDistance = 14;
  const labelSpace = formatValue && !splitLabels ? labelDistance + spread / 2 : 0;
  const height = Math.max(formatValue && splitLabels ? 56 : 48, 24 + spread + labelSpace);
  return (
    <BaseSlider.Root {...props} value={value} thumbAlignment={thumbAlignment} className={`data-disabled:opacity-35 ${className}`}>
      <BaseSlider.Control style={{ height, paddingTop: labelSpace }} className={`flex w-full touch-none select-none items-center ${thumbAlignment === 'center' ? 'px-3' : ''}`}>
        <BaseSlider.Track className={`${off} relative h-2 w-full rounded-full`}>
          <BaseSlider.Indicator className={`${on} h-full rounded-full`} />
          {values.map((amount, index) => {
            const offset = index * stagger - spread / 2;
            const labelPosition = splitLabels && index === 1
              ? { top: `calc(50% + ${labelDistance - offset}px)` }
              : { bottom: `calc(50% + ${splitLabels ? labelDistance + offset : labelSpace}px)` };
            return (
              <BaseSlider.Thumb
                key={index}
                index={index}
                aria-label={nameOf(index)}
                aria-valuetext={textOf(index)}
                style={{ top: `calc(50% + ${offset}px)` }}
                className="h-6 w-6 cursor-grab rounded-sm has-[:focus-visible]:outline-solid has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-offset-2 data-dragging:cursor-grabbing data-disabled:cursor-not-allowed"
              >
                <span aria-hidden="true" style={{ top: `calc(50% + ${-offset}px)` }} className="pointer-events-none absolute left-1/2 h-5 w-1 -translate-1/2 rounded-full bg-ink-strong ring-1 ring-outline" />
                {formatValue && (
                  <span aria-hidden="true" style={labelPosition} className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-xs/none font-[550] text-ink tabular-nums">
                    {formatValue(amount, index)}
                  </span>
                )}
              </BaseSlider.Thumb>
            );
          })}
        </BaseSlider.Track>
      </BaseSlider.Control>
    </BaseSlider.Root>
  );
}
