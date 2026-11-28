import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar } from '../index.ts';

const placeholder = (container: HTMLElement) => container.querySelector('img[src*="empty-thumbnail"]');

describe('Avatar', () => {
  it('shows the name on one row that is cut, with all of it on the pointer', () => {
    const name = 'Actor With A Very Long Name That Does Not Fit';
    const { container } = render(<Avatar image="/actor.jpg" name={name} />);

    const row = container.querySelector('.truncate')!;
    expect(row.textContent).toBe(name);
    expect(row.getAttribute('title')).toBe(name);
  });

  it('gives the image no text of its own', () => {
    const { container } = render(<Avatar image="/actor.jpg" name="Actor One" />);

    expect(container.querySelector('img[src="/actor.jpg"]')!.getAttribute('alt')).toBe('');
  });

  it('renders the placeholder when the image is an empty string', () => {
    const { container } = render(<Avatar image="" name="Actor One" />);

    expect(placeholder(container)).toBeTruthy();
  });

  it('renders the placeholder while the image loads, and no placeholder after it loads', () => {
    const { container } = render(<Avatar image="/actor.jpg" name="Actor One" />);

    expect(placeholder(container)).toBeTruthy();

    fireEvent.load(container.querySelector('img[src="/actor.jpg"]')!);

    expect(placeholder(container)).toBeNull();
  });
});
