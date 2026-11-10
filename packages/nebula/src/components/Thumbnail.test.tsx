import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Thumbnail } from '../index.ts';

const placeholder = (container: HTMLElement) => container.querySelector('img[src*="empty-thumbnail"]');

describe('Thumbnail', () => {
  it('renders the placeholder when it has no image', () => {
    const { container } = render(<Thumbnail image={undefined as unknown as string} title="Dune" year={2021} />);

    expect(placeholder(container)).toBeTruthy();
  });

  it('renders the placeholder when the image is an empty string', () => {
    const { container } = render(<Thumbnail image="" title="Dune" year={2021} />);

    expect(placeholder(container)).toBeTruthy();
  });

  it('renders no placeholder when it has an image', () => {
    const { container } = render(<Thumbnail image="/dune.jpg" title="Dune" year={2021} />);

    expect(placeholder(container)).toBeNull();
  });

  it('renders no placeholder while it loads', () => {
    const { container } = render(<Thumbnail loading title="Dune" year={2021} />);

    expect(placeholder(container)).toBeNull();
  });
});
