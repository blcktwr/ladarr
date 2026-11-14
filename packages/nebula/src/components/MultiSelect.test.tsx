import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MultiSelect } from '../index.ts';

const OPTIONS = [
  { value: '2000', label: 'Movies' },
  { value: '5000', label: 'TV' },
  { value: '5070', label: 'Anime' },
];

function renderMultiSelect(props: Partial<ComponentProps<typeof MultiSelect>> = {}) {
  const onValueChange = vi.fn();
  render(<MultiSelect label="Categories" value={[]} onValueChange={onValueChange} options={OPTIONS} {...props} />);
  return { onValueChange, input: screen.getByLabelText('Categories') as HTMLInputElement };
}

describe('MultiSelect', () => {
  it('counts the selected options in the field and takes no text', () => {
    const { input } = renderMultiSelect({ value: ['2000', '5070'] });

    expect(input.value).toBe('2 selected');
    expect(input.readOnly).toBe(true);
  });

  it('shows the count with a custom text', () => {
    const { input } = renderMultiSelect({ value: ['5000'], valueText: (count) => `${count} picked` });

    expect(input.value).toBe('1 picked');
  });

  it('opens the list on focus and adds the clicked option', async () => {
    const { onValueChange, input } = renderMultiSelect();

    fireEvent.focus(input);
    fireEvent.click(await screen.findByText('TV'));

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith(['5000']);
  });

  it('opens the list on a click', async () => {
    const { input } = renderMultiSelect();

    fireEvent.click(input);

    expect(await screen.findByText('Anime')).toBeTruthy();
  });

  it('keeps the list open while more than one option is chosen', async () => {
    function Controlled() {
      const [value, setValue] = useState<string[]>([]);
      return <MultiSelect label="Categories" value={value} onValueChange={setValue} options={OPTIONS} />;
    }
    render(<Controlled />);
    const input = screen.getByLabelText('Categories') as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.click(await screen.findByText('TV'));
    expect(input.value).toBe('1 selected');

    fireEvent.click(await screen.findByText('Anime'));
    expect(input.value).toBe('2 selected');
    expect(screen.getByText('Movies')).toBeTruthy();
  });

  it('shows the description and the error, and takes no click while it is off', () => {
    renderMultiSelect({ description: 'The categories of a search.', error: 'Pick one.' });

    expect(screen.getByText('The categories of a search.')).toBeTruthy();
    expect(screen.getByText('Pick one.')).toBeTruthy();
  });
});
