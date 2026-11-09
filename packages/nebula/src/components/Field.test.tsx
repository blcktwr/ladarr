import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Field } from '../index.ts';

describe('Field', () => {
  it('renders the suffix and keeps the label as the accessible name', () => {
    render(<Field label="Timeout" suffix="ms" />);

    expect(screen.getByRole('textbox', { name: 'Timeout' }).tagName).toBe('INPUT');
    expect(screen.getByText('ms')).toBeTruthy();
  });

  it('renders the suffix in the row of the input, not beside the whole field', () => {
    render(<Field label="Timeout" suffix="ms" />);

    const input = screen.getByRole('textbox', { name: 'Timeout' });
    const suffix = screen.getByText('ms');
    const field = screen.getByText('Timeout').parentElement;

    expect(suffix.parentElement).toBe(input.parentElement);
    expect(suffix.parentElement).not.toBe(field);
    expect(input.compareDocumentPosition(suffix) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders no unit text when suffix is not given', () => {
    const { container } = render(<Field label="Timeout" />);

    expect(screen.queryByText('ms')).toBeNull();
    expect(container.textContent?.trim()).toBe('Timeout');
  });

  it('renders the suffix with the error, and the error text still shows', () => {
    render(<Field label="Timeout" suffix="ms" error="Enter a time." />);

    expect(screen.getByText('ms')).toBeTruthy();
    expect(screen.getByText('Enter a time.')).toBeTruthy();
  });

  it('renders the suffix inside the field and the action after it in the same row', () => {
    render(<Field label="Timeout" suffix="ms" action={<button type="button">Apply</button>} />);

    const input = screen.getByRole('textbox', { name: 'Timeout' });
    const suffix = screen.getByText('ms');
    const action = screen.getByRole('button', { name: 'Apply' });
    const field = input.parentElement!;

    expect(field.contains(suffix)).toBe(true);
    expect(field.contains(action)).toBe(false);
    expect(action.parentElement).toBe(field.parentElement);
    expect(field.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
