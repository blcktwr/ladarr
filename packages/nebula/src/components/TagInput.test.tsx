import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TagInput } from '../index.ts';

const OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'th', label: 'Thai' },
  { value: 'fr', label: 'French' },
];

function renderTagInput(props: Partial<ComponentProps<typeof TagInput>> = {}) {
  const onValueChange = vi.fn();
  render(<TagInput label="Languages" value={[]} onValueChange={onValueChange} options={OPTIONS} {...props} />);
  return { onValueChange, input: screen.getByLabelText('Languages') };
}

describe('TagInput', () => {
  it('renders a chip for every value with the option label and removes the clicked chip', () => {
    const { onValueChange } = renderTagInput({ value: ['en', 'th'] });

    expect(screen.getByText('English')).toBeTruthy();
    expect(screen.getByText('Thai')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Thai' }));

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith(['en']);
  });

  it('filters the option list by the typed text', async () => {
    const { input } = renderTagInput();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Th' } });

    expect(await screen.findByText('Thai')).toBeTruthy();
    expect(screen.queryByText('English')).toBeNull();
  });

  it('shows the empty text when the option list is empty and the input has focus', async () => {
    const { input } = renderTagInput({ options: [], emptyText: 'No languages yet.' });

    fireEvent.focus(input);

    expect(await screen.findByText('No languages yet.')).toBeTruthy();
  });

  it('shows the empty text when the typed text matches no option', async () => {
    const { input } = renderTagInput({ emptyText: 'No languages match.' });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Klingon' } });

    expect(await screen.findByText('No languages match.')).toBeTruthy();
    expect(screen.queryByText('English')).toBeNull();
  });

  it('shows "No options." when emptyText is not given', async () => {
    const { input } = renderTagInput({ options: [] });

    fireEvent.focus(input);

    expect(await screen.findByText('No options.')).toBeTruthy();
  });

  it('adds the value of the clicked option', async () => {
    const { onValueChange, input } = renderTagInput();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Th' } });
    fireEvent.click(await screen.findByText('Thai'));

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith(['th']);
  });

  it('closes the dropdown after a selection and keeps it closed after a click outside', async () => {
    const { input } = renderTagInput();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Th' } });
    fireEvent.click(await screen.findByText('Thai'));

    expect(input.getAttribute('aria-expanded')).toBe('false');

    fireEvent.pointerDown(document.body);

    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('adds the typed text as a custom tag when no option matches', () => {
    const { onValueChange, input } = renderTagInput();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Klingon' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith(['Klingon']);
  });

  it('adds the option value and not its label when the typed text matches an option', async () => {
    const { onValueChange, input } = renderTagInput();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Thai' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith(['th']);
  });

  it('shows the error and the description, and blocks changes while disabled', () => {
    renderTagInput({
      value: ['th'],
      disabled: true,
      description: 'The languages of the subtitles.',
      error: 'Pick at least one language.',
    });

    expect(screen.getByText('The languages of the subtitles.')).toBeTruthy();
    expect(screen.getByText('Pick at least one language.')).toBeTruthy();

    const input = screen.getByLabelText('Languages') as HTMLInputElement;
    expect(input.disabled).toBe(true);

    const remove = screen.getByRole('button', { name: 'Remove Thai' }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
  });
});
