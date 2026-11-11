// The looks of the stone, as Tailwind classes. The colours and shadows are theme tokens in index.css.

// The label of a key: its emboss, its transition, and its 2px drop when pressed. The key and the tab add their size.
const label = 'outline-none font-[550] tracking-[.01em] text-shadow-(--emboss) whitespace-nowrap select-none [-webkit-tap-highlight-color:transparent] transition-[background-color,color,box-shadow] duration-200 ease-stone pressed:pt-0.5 pressed:duration-[60ms] motion-reduce:transition-none';

// A key of carved stone. Pressing it sinks its label with it. Each key adds its own size, shape and look.
export const key = `box-border text-[15px]/none ${label}`;

// A raised block of stone that does not react, such as a poster.
export const block = 'bg-(image:--stone) shadow-(--edge) text-ink';

// A tag that hangs on a poster, such as the type of content: a key of the accent with a notch in its bottom edge.
// The shadow follows the notch, so the tag looks cut from the poster and not like a box.
export const bookmark = 'bg-(image:--key) shadow-(--bookmark-edge) text-night text-shadow-(--emboss) [filter:drop-shadow(var(--bookmark-shadow))]';

// A raised block that lightens when pointed at and sinks into the wall when pressed.
export const raised = `${block} pointed:bg-(image:--stone-lit) pointed:shadow-(--edge-lit) pointed:text-ink-strong pressed:bg-none pressed:bg-(--stone-sunk) pressed:shadow-(--edge-sunk) pressed:text-ink-strong`;

// No block to raise: pointing at it carves a recess.
export const ghost = 'bg-transparent text-fog pointed:bg-(--recess-lit) pointed:shadow-(--recess-edge-lit) pointed:text-ink pressed:bg-(--recess-sunk) pressed:shadow-(--recess-edge-sunk) pressed:text-ink';

// A simple link: the label in the accent, with no block. The line shows only when the pointer is on it.
export const link = 'bg-transparent text-accent underline-offset-4 pointed:underline text-shadow-none';

// Plain text with no block, no line and no bold. The label takes the color of the text around it.
export const plain = 'bg-transparent text-current text-shadow-none font-normal!';

// A simple link on a colored surface: the label takes the color of the text around it.
export const linkInherit = 'bg-transparent text-current underline-offset-4 pointed:underline text-shadow-none';

// The stone under the content of a page, with its grain and its shadow. The layout of its content comes from the component.
const surface = 'min-w-0 p-6 rounded-lg bg-(image:--grain) bg-pane shadow-(--slab-shadow) text-ink';

// The stone under the content of a page. It is a grid with space between its children, and they keep their own width.
export const pane = `grid grid-cols-[minmax(0,1fr)] justify-items-start gap-10 ${surface}`;

// The stone of a modal, which holds its content in a column.
export const modalSurface = `${surface} flex flex-col gap-5`;

// A key made of red, for an action that destroys data. Its label is white. It has the relief of a key, as on.
export const danger = 'bg-(image:--danger) shadow-(--danger-edge) text-ink-light pointed:bg-(image:--danger-lit) pressed:bg-none pressed:bg-(--danger-sunk) pressed:shadow-(--edge-sunk)';

// A wheel that turns while something loads. Add its size.
export const wheel = 'box-border shrink-0 border-2 border-haze/20 border-t-ink rounded-full animate-turn motion-reduce:[animation-duration:3s]';

// A tab of the navbar, such as a section link: a key at 17px. Add ghost to it, or current if it is the current tab. Its bar reaches up to the top edge of the page.
export const tab = `${label} [--bar-top:-0.75rem] sm:[--bar-top:-1rem] flex items-center justify-center gap-2 h-10 px-4.5 rounded-md text-[17px]/none no-underline cursor-pointer focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-3 [&>svg]:size-4.5 [&>svg]:shrink-0`;

// The mark of the current item: a short bar of the accent, in place of ghost.
const bar = 'relative text-ink-strong after:absolute after:bg-(image:--key) after:shadow-(--bar-edge)';

// The current item of a tab list: the bar hangs from the top edge of the item, with round bottom corners.
export const current = `${bar} after:top-[var(--bar-top,0px)] after:left-1/2 after:w-6 after:h-1 after:-translate-x-1/2 after:rounded-b-sm`;

// The current item of a side menu: the bar touches the left edge of the list, past the 4px padding of the list, with round right corners.
export const currentSide = `${bar} after:-left-1 after:top-1/2 after:w-1 after:h-6 after:-translate-y-1/2 after:rounded-r-sm`;

// A recess that stays pressed in, such as the selected option of a list.
export const sunk = 'bg-(--recess-sunk) shadow-(--recess-edge-sunk) text-ink pt-0.5';

// A checkbox or a switch that is off: a slot in the stone, deeper than the pane. Pointing at it lightens the slot.
export const off = 'bg-(--recess-sunk) shadow-(--recess-edge-sunk) pointed:bg-(--recess-lit) pointed:shadow-(--recess-edge-lit) pressed:bg-(--recess-sunk) pressed:shadow-(--recess-edge-sunk)';

// A key that is on, such as a checked checkbox or switch: made of the accent, with the same relief.
export const on = 'bg-(image:--key) shadow-(--key-edge) text-ink pressed:bg-none pressed:bg-(--key-sunk) pressed:shadow-(--edge-sunk) pressed:text-ink-strong';

// A line between two parts of a pane: a groove carved in the stone, deeper than the groove between the rows of a table.
export const divider = 'box-border w-full h-0.5 shrink-0 bg-(image:--divider) bg-[length:100%_1px,100%_1px] bg-[position:0_0,0_100%] bg-no-repeat';

// A field is a flat block of the stone, with no line on its edge. Pointing at it lightens it.
// A ring inside its edge shows its state: the accent when it has the focus, red when it is invalid.
const flatSurface = 'box-border rounded-md outline-none text-ink-strong caret-point font-medium transition-[background-color,box-shadow] duration-200 ease-stone placeholder:text-fog placeholder:opacity-60 focus-visible:inset-ring-3 focus-visible:inset-ring-accent data-invalid:inset-ring-3 data-invalid:inset-ring-error data-disabled:opacity-35 data-disabled:cursor-not-allowed data-deactivated:struck';
export const flat = `${flatSurface} h-11 bg-field hover:not-data-disabled:bg-field-hover`;
// A small field, for a value in a row of a table or a dense form. Its stone differs from a field, so it shows on a recess.
export const flatSmall = `${flatSurface} h-7 bg-field-small hover:not-data-disabled:bg-field-small-hover`;
// A field that holds a row of chips. It grows with the chips, and its focus ring shows for the input inside it.
export const flatField = `${flatSurface} min-h-11 bg-field hover:not-data-disabled:bg-field-hover focus-within:inset-ring-3 focus-within:inset-ring-accent`;
// A tag inside a field. It is flat, so it reads as a value and not as a key.
export const chip = 'box-border inline-flex items-center gap-1.5 h-7 pl-2.5 pr-1 rounded-sm bg-haze/10 text-ink text-[13px]/none font-[550] whitespace-nowrap';

// A checkbox or a switch with its label. A disabled one fades. A deactivated one also is struck out, label too.
// It aligns by its middle, so the line does not move when the check shows or the key is pressed.
export const toggle = 'relative inline-flex items-center align-middle gap-3 text-ink text-[15px]/none font-medium cursor-pointer has-data-disabled:opacity-35 has-data-disabled:cursor-not-allowed has-data-deactivated:after:absolute has-data-deactivated:after:-inset-1 has-data-deactivated:after:bg-(image:--strike)';
