import { fireEvent, render, screen } from '@testing-library/react';
import { createPortal } from 'react-dom';
import { describe, expect, it, vi } from 'vitest';
import { Table } from '../index.ts';

// A press of the space bar, as the browser sends it.
function pressSpace(target: Element, keys = {}) {
  fireEvent.keyDown(target, { key: ' ', code: 'Space', ...keys });
  fireEvent.keyUp(target, { key: ' ', code: 'Space', ...keys });
}

// Fires every event that can select a row. A result of false means that the event lost its default action.
function fireAll(target: Element) {
  fireEvent.click(target);
  fireEvent.click(target, { ctrlKey: true });
  fireEvent.click(target, { shiftKey: true });
  pressSpace(target);
  return {
    contextMenu: fireEvent.contextMenu(target, { button: 0, ctrlKey: true }),
    mouseDown: fireEvent.mouseDown(target, { shiftKey: true }),
  };
}

const CONTROLS = (
  <>
    <button type="button"><span>Inside a button</span></button>
    <a href="#files">A link</a>
    <input aria-label="An input" />
    <select aria-label="A select"><option>One</option></select>
    <textarea aria-label="A text area" />
    <label>A label</label>
    <span role="button">A button role</span>
    <span role="link">A link role</span>
    <span role="menuitem">A menu item role</span>
  </>
);

describe.each([['a plain', false], ['an animated', true]] as const)('Table row selection in %s table', (_name, animated) => {
  function renderTable() {
    const onSelect = vi.fn();
    render(
      <Table
        aria-label="Episodes"
        animated={animated}
        columns={[{ label: 'Episode' }, { label: 'Controls' }]}
        rows={[
          { key: 'first', selected: false, onSelect, cells: ['S01E01', CONTROLS] },
          // An option of a dropdown is in a portal, and its events still go up to the row.
          { key: 'second', selected: true, onSelect, cells: ['S01E02', createPortal(<div>In a portal</div>, document.body)] },
          { key: 'third', cells: ['S01E03', 'No selection'] },
        ]}
      />,
    );
    const row = (episode: string) => screen.getByText(episode).closest('tr')!;
    // The row itself still selects, so a test of an ignored event can not pass on a table without selection.
    const expectOnlyClick = () => {
      expect(onSelect).not.toHaveBeenCalled();
      fireEvent.click(screen.getByText('S01E01'));
      expect(onSelect).toHaveBeenCalledTimes(1);
    };
    return { onSelect, row, expectOnlyClick };
  }

  it('gives a row that can be selected a tab stop and its state', () => {
    const { row } = renderTable();

    expect(row('S01E01').getAttribute('tabindex')).toBe('0');
    expect(row('S01E01').getAttribute('aria-selected')).toBe('false');
    expect(row('S01E02').getAttribute('tabindex')).toBe('0');
    expect(row('S01E02').getAttribute('aria-selected')).toBe('true');
  });

  it.each([
    ['no key', {}, 'one'],
    ['Ctrl', { ctrlKey: true }, 'toggle'],
    ['Cmd', { metaKey: true }, 'toggle'],
    ['Shift', { shiftKey: true }, 'range'],
  ])('selects with a click and %s', (_key, keys, mode) => {
    const { onSelect } = renderTable();

    fireEvent.click(screen.getByText('S01E01'), keys);

    expect(onSelect.mock.calls).toEqual([[mode]]);
  });

  it.each([
    ['Ctrl', {}, 'toggle'],
    ['Ctrl and Shift', { shiftKey: true }, 'range'],
  ])('selects with the context menu that macOS opens on %s and a click', (_key, keys, mode) => {
    const { onSelect } = renderTable();

    const allowed = fireEvent.contextMenu(screen.getByText('S01E01'), { button: 0, ctrlKey: true, ...keys });

    expect(allowed).toBe(false);
    expect(onSelect.mock.calls).toEqual([[mode]]);
  });

  it.each([
    ['the right button', { button: 2 }],
    ['the right button and Ctrl', { button: 2, ctrlKey: true }],
    ['no Ctrl', { button: 0 }],
  ])('keeps the context menu of %s', (_name, keys) => {
    const { expectOnlyClick } = renderTable();

    const allowed = fireEvent.contextMenu(screen.getByText('S01E01'), keys);

    expect(allowed).toBe(true);
    expectOnlyClick();
  });

  it('stops the browser from a text selection on a press with Shift only', () => {
    renderTable();
    const episode = screen.getByText('S01E01');

    expect(fireEvent.mouseDown(episode, { shiftKey: true })).toBe(false);
    expect(fireEvent.mouseDown(episode)).toBe(true);
  });

  it.each([
    ['no key', {}, 'toggle'],
    ['Shift', { shiftKey: true }, 'range'],
  ])('selects the row that has the focus with Space and %s', (_key, keys, mode) => {
    const { onSelect, row } = renderTable();

    pressSpace(row('S01E01'), keys);

    expect(onSelect.mock.calls).toEqual([[mode]]);
  });

  it('ignores Space on a part of the row', () => {
    const { expectOnlyClick } = renderTable();

    pressSpace(screen.getByText('S01E01'));

    expectOnlyClick();
  });

  it.each([
    'Inside a button', 'A link', 'An input', 'A select', 'A text area', 'A label', 'A button role', 'A link role', 'A menu item role',
  ])('ignores the events of a control: %s', (name) => {
    const { expectOnlyClick } = renderTable();
    const target = screen.queryByLabelText(name) ?? screen.getByText(name);

    const allowed = fireAll(target);

    expect(allowed).toEqual({ contextMenu: true, mouseDown: true });
    expectOnlyClick();
  });

  it('ignores the events of a portal', () => {
    const { expectOnlyClick } = renderTable();

    const allowed = fireAll(screen.getByText('In a portal'));

    expect(allowed).toEqual({ contextMenu: true, mouseDown: true });
    expectOnlyClick();
  });

  it('does not select a row without onSelect', () => {
    const { row, expectOnlyClick } = renderTable();

    const allowed = fireAll(screen.getByText('S01E03'));
    pressSpace(row('S01E03'));

    expect(row('S01E03').hasAttribute('tabindex')).toBe(false);
    expect(row('S01E03').hasAttribute('aria-selected')).toBe(false);
    expect(allowed).toEqual({ contextMenu: true, mouseDown: true });
    expectOnlyClick();
  });
});
