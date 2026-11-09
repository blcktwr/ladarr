import { AnimatePresence, motion, useReducedMotion, type Transition } from 'motion/react';
import { Fragment, useId, type MouseEvent, type ReactNode } from 'react';
import { Actions } from './Actions.tsx';
import { Skeleton } from './Skeleton.tsx';

type Column = {
  // The text of the column, or a control such as a Checkbox that selects every row.
  label: ReactNode;
  // end puts the cells at the end of the column, such as for a number or an ActionMenu.
  align?: 'start' | 'end';
  // The label is for a screen reader only, such as the label of a column of actions.
  hideLabel?: boolean;
  // A width for the column, such as '6rem'. The table is full width, so the other columns share the rest.
  width?: string;
};

// A row of the table. A row with a click opens something, such as the episodes of a series.
// A row can have a detail: content that opens under it, across all the columns, such as the episodes of a season.
type Row = { key: string; cells: ReactNode[]; onClick?: () => void; detail?: ReactNode };

// The title shows above the table, and it is the name of the table. Without a title, aria-label is the name.
type TableProps = ({ title: string; 'aria-label'?: never } | { title?: never; 'aria-label': string }) & {
  columns: Column[];
  // One cell for each column, in the order of the columns.
  rows?: Row[];
  loading?: boolean;
  // A control at the right of the title, such as a Button that adds a row. The row of the title is as tall as the control, so the control does not touch the labels of the columns.
  action?: ReactNode;
  // A row that enters, leaves, or moves goes to its place in 200ms, and so does the detail under it.
  animated?: boolean;
};

// The cells of the first and the last column have the padding of the pane, so the text aligns with the content of the pane.
const cell = 'px-3 first:pl-6 last:pr-6';

// A click on a control inside a row keeps the action of the control.
const control = 'button, a, input, select, textarea, [role="button"], [role="link"], [role="menuitem"]';

// The motion of a row follows the theme: the ease-stone curve, in 200ms.
const transition: Transition = { duration: 0.2, ease: [0.16, 1, 0.3, 1] };

// A row enters from below and leaves toward the top, so the rows move up as the work goes on. The top row is the work
// that is closest to its end.
const shift = 8;

// A table of data on a pane. It goes past the padding of the pane to its two edges, so the grooves between the rows go across the full pane.
// The grooves are carved in the pane: a dark line, with a bright line under it. A wide table scrolls inside the pane.
// It can have a title above it, as a Section. While loading is on, three rows show a bar in each cell.
// A row can have a click that opens something, such as the episodes of a series, and a detail that opens under it, across all the columns.
// The pointer shows the click, and a click on a control inside the row keeps the action of the control.
// With animated, a row that enters, leaves, or moves takes its place with motion, unless the system asks for reduced motion.
export function Table({ title, 'aria-label': label, columns, rows = [], loading = false, action, animated = false }: TableProps) {
  const body: Row[] = loading ? ['1', '2', '3'].map(key => ({ key, cells: columns.map((_, index) => <Skeleton key={index} className="inline-block align-middle h-3.5 w-24 max-w-full" />) })) : rows;
  // A width keeps the columns the same for every row set, so the layout does not follow the content.
  const fixed = columns.some(column => column.width);
  const id = useId();
  const still = useReducedMotion();
  const moving = animated && !still;

  const click = (row: Row) =>
    row.onClick
      ? (event: MouseEvent<HTMLTableRowElement>) => {
          if (!(event.target instanceof Element) || !event.target.closest(control)) row.onClick?.();
        }
      : undefined;

  const cells = (row: Row) =>
    row.cells.map((content, index) => (
      <td key={index} className={`${cell} h-16 py-2 ${columns[index]?.align === 'end' ? 'text-right' : 'text-left'}`}>
        {content}
      </td>
    ));
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 justify-self-stretch">
      {(title || action) && (
        // On a narrow screen, the control goes below the title, at the right.
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          {title && <h2 id={id} className="text-ink-strong text-[17px]/none font-semibold">{title}</h2>}
          {action && <div className="ml-auto"><Actions>{action}</Actions></div>}
        </div>
      )}
      <div className="-mx-6 overflow-x-auto overflow-y-hidden [contain:paint]">
        <table aria-label={label} aria-labelledby={title ? id : undefined} aria-busy={loading || undefined} className={`w-full border-separate border-spacing-0 text-ink text-[15px]/6 ${fixed ? 'table-fixed' : ''}`}>
          <colgroup>
            {columns.map((column, index) => <col key={index} style={column.width ? { width: column.width } : undefined} />)}
          </colgroup>
          <thead className={columns.every(column => column.hideLabel) ? 'sr-only' : undefined}>
            <tr>
              {columns.map((column, index) => (
                <th key={index} scope="col" className={`${cell} pb-3 whitespace-nowrap text-fog text-[15px]/6 font-[550] ${column.align === 'end' ? 'text-right' : 'text-left'}`}>
                  <span className={column.hideLabel ? 'sr-only' : ''}>{column.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="[&>tr+tr>td]:shadow-(--groove)">
            {moving ? (
              <AnimatePresence initial={false} mode="popLayout">
                {body.flatMap(row => [
                  <motion.tr
                    key={row.key}
                    data-row={row.key}
                    layout="position"
                    initial={{ opacity: 0, y: shift }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -shift }}
                    transition={transition}
                    onClick={click(row)}
                    className={row.onClick ? 'cursor-pointer' : undefined}
                  >
                    {cells(row)}
                  </motion.tr>,
                  ...(row.detail
                    ? [
                        <motion.tr key={`${row.key}:detail`} layout="position" initial={{ opacity: 0, y: shift }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -shift }} transition={transition}>
                          <td colSpan={columns.length} className="px-6 py-2 bg-(--recess-lit)">
                            {row.detail}
                          </td>
                        </motion.tr>,
                      ]
                    : []),
                ])}
              </AnimatePresence>
            ) : (
              body.map(row => (
                <Fragment key={row.key}>
                  <tr data-row={row.key} onClick={click(row)} className={row.onClick ? 'cursor-pointer' : undefined}>
                    {cells(row)}
                  </tr>
                  {row.detail && (
                    <tr>
                      <td colSpan={columns.length} className="px-6 py-2 bg-(--recess-lit)">
                        {row.detail}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
