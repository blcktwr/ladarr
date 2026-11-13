import { fireEvent, render } from '@testing-library/react';
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

  it('renders the placeholder while the image loads, and no placeholder after it loads', () => {
    const { container } = render(<Thumbnail image="/dune.jpg" title="Dune" year={2021} />);

    expect(placeholder(container)).toBeTruthy();

    fireEvent.load(container.querySelector('img[src="/dune.jpg"]')!);

    expect(placeholder(container)).toBeNull();
  });

  it('renders the placeholder while it loads', () => {
    const { container } = render(<Thumbnail loading title="Dune" year={2021} />);

    expect(placeholder(container)).toBeTruthy();
  });

  it('dims the thumbnail when dimmed is on', () => {
    const { container } = render(<Thumbnail image="/dune.jpg" title="Dune" year={2021} dimmed />);

    expect(container.querySelector('figure')!.className).toContain('opacity-40');
  });

  it('shows the title and the year without a status', () => {
    const { container } = render(<Thumbnail image="/dune.jpg" title="Dune" year={2021} />);

    expect(container.querySelector('.truncate')!.textContent).toBe('Dune');
    expect(container.querySelector('figcaption')!.textContent).toContain('2021');
  });

  it('shows the status in place of the title and the year', () => {
    const { container } = render(<Thumbnail image="/dune.jpg" title="Dune" year={2021} status="In catalog" />);

    expect(container.querySelector('.truncate')!.textContent).toBe('In catalog');
    expect(container.querySelector('figcaption')!.textContent).not.toContain('2021');
  });

  it('keeps the title for a screen reader when the status shows', () => {
    const { container } = render(<Thumbnail image="/dune.jpg" title="Dune" year={2021} status="In catalog" />);

    expect(container.querySelector('.sr-only')!.textContent).toBe('Dune');
  });

  it('shows a state icon in the bookmark when it has a type and a state', () => {
    const { container } = render(<Thumbnail image="/dune.jpg" title="Dune" year={2021} type="Movies" state="searching" stateLabel="Searching" />);

    expect(container.querySelector('figcaption svg')).toBeTruthy();
  });

  it('gives the state label for a screen reader', () => {
    const { container } = render(<Thumbnail image="/dune.jpg" title="Dune" year={2021} type="Movies" state="searching" stateLabel="Searching" />);

    expect(container.querySelector('figcaption')!.textContent).toContain('Searching');
  });

  it('shows no state icon with a type and no state', () => {
    const { container } = render(<Thumbnail image="/dune.jpg" title="Dune" year={2021} type="Movies" />);

    expect(container.querySelector('figcaption svg')).toBeNull();
  });

  it('shows no state icon while it loads', () => {
    const { container } = render(<Thumbnail loading title="Dune" year={2021} type="Movies" state="searching" stateLabel="Searching" />);

    expect(container.querySelector('figcaption svg')).toBeNull();
  });

  it('shows no state icon without a type', () => {
    const { container } = render(<Thumbnail image="/dune.jpg" title="Dune" year={2021} state="searching" stateLabel="Searching" />);

    expect(container.querySelector('figcaption svg')).toBeNull();
  });

  it('keeps the type on the bookmark while the state shows', () => {
    const { container } = render(<Thumbnail image="/dune.jpg" title="Dune" year={2021} type="Movies" state="searching" stateLabel="Searching" />);

    expect(container.querySelector('figcaption')!.textContent).toContain('Movies');
  });

  it('shows no text under the poster without a caption', () => {
    const { container } = render(<Thumbnail image="/dune.jpg" title="Dune" year={2021} noCaption />);

    const caption = container.querySelector('figcaption')!;
    expect(caption.querySelector('.truncate')).toBeNull();
    expect(caption.textContent).not.toContain('2021');
    expect(caption.querySelector('.sr-only')!.textContent).toBe('Dune');
  });
});
