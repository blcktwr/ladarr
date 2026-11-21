import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SearchableDropdown } from '../index.ts';

const OPTIONS = [
  { value: 'a1b2c3', label: 'Show.Name.First.Part' },
  { value: 'd4e5f6', label: 'Show.Name.Second.Part' },
  { value: '123abc', label: 'Other.Show' },
];

function renderDropdown(props: Partial<ComponentProps<typeof SearchableDropdown>> = {}) {
  const onValueChange = vi.fn();
  render(<SearchableDropdown label="Torrent" value="" onValueChange={onValueChange} options={OPTIONS} {...props} />);
  return { onValueChange, input: screen.getByRole('combobox', { name: 'Torrent' }) as HTMLInputElement };
}

describe('SearchableDropdown', () => {
  it('shows the label of the selected hash without a tag', () => {
    const { input } = renderDropdown({ value: 'd4e5f6' });

    expect(input.value).toBe('Show.Name.Second.Part');
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });

  it('keeps the accessible label when the visible label is hidden', () => {
    const { input } = renderDropdown({ hideLabel: true, width: 'full' });

    expect(input).toBeTruthy();
    expect(screen.getByText('Torrent').classList.contains('sr-only')).toBe(true);
  });

  it('filters options by label without regard to case', async () => {
    const { input } = renderDropdown();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'second.part' } });

    expect(await screen.findByRole('option', { name: 'Show.Name.Second.Part' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Show.Name.First.Part' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Other.Show' })).toBeNull();
    expect(input.value).toBe('second.part');
  });

  it('keeps the selected label visible and skips the disabled input on focus', () => {
    const { input, onValueChange } = renderDropdown({ disabled: true, value: 'a1b2c3' });

    expect(input.disabled).toBe(true);
    expect(input.value).toBe('Show.Name.First.Part');
    input.focus();
    expect(document.activeElement).not.toBe(input);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('sends the hash of a selected label and closes the list', async () => {
    const { onValueChange, input } = renderDropdown();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Second' } });
    fireEvent.click(await screen.findByRole('option', { name: 'Show.Name.Second.Part' }));

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith('d4e5f6');
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('selects an option with the keyboard', async () => {
    const { onValueChange, input } = renderDropdown();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Second' } });
    expect(await screen.findByRole('option', { name: 'Show.Name.Second.Part' })).toBeTruthy();
    fireEvent.keyDown(input, { key: 'ArrowDown', code: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith('d4e5f6');
  });

  it('replaces the selected value instead of adding a tag', async () => {
    function Controlled() {
      const [value, setValue] = useState('a1b2c3');
      return <SearchableDropdown label="Torrent" value={value} onValueChange={setValue} options={OPTIONS} />;
    }
    render(<Controlled />);
    const input = screen.getByRole('combobox', { name: 'Torrent' }) as HTMLInputElement;

    expect(input.value).toBe('Show.Name.First.Part');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Second' } });
    fireEvent.click(await screen.findByRole('option', { name: 'Show.Name.Second.Part' }));

    expect(input.value).toBe('Show.Name.Second.Part');
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });

  it('shows the empty text when there are no options', async () => {
    const { input } = renderDropdown({ options: [], emptyText: 'No options.' });

    fireEvent.focus(input);

    expect(await screen.findByText('No options.')).toBeTruthy();
  });

  it('shows the empty text and does not select custom text when no label matches', async () => {
    const { onValueChange, input } = renderDropdown({ emptyText: 'No options.' });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'No match' } });
    expect(await screen.findByText('No options.')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(onValueChange).not.toHaveBeenCalled();
  });
});
