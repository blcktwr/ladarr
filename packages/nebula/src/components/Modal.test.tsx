import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it } from 'vitest';
import { Button, Modal } from '../index.ts';

async function openTabbedModal() {
  render(
    <Modal
      trigger={<Button>Open tabbed modal</Button>}
      title="Downloaded file"
      hideTitle
      tabs={[
        { value: 'file', label: 'File', content: <p>File details</p> },
        { value: 'torrent', label: 'Torrent', content: <p>Torrent details</p> },
      ]}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Open tabbed modal' }));
  return within(await screen.findByRole('dialog', { name: 'Downloaded file' }));
}

function expectPanel(dialog: ReturnType<typeof within>, selected: 'File' | 'Torrent', other: 'File' | 'Torrent') {
  const tablist = within(dialog.getByRole('tablist'));
  const tab = tablist.getByRole('tab', { name: selected, selected: true });
  const panel = dialog.getByRole('tabpanel', { name: selected });

  expect(tablist.getByRole('tab', { name: other, selected: false }).tabIndex).toBe(-1);
  expect(tab.tabIndex).toBe(0);
  expect(panel.id).not.toBe('');
  expect(tab.getAttribute('aria-controls')).toBe(panel.id);
  expect(within(panel).getByText(`${selected} details`)).toBeTruthy();
  expect(dialog.getAllByRole('tabpanel')).toEqual([panel]);
}

describe('Modal start actions', () => {
  // The footer is the last part of the dialog.
  async function footerOf(props: Pick<ComponentProps<typeof Modal>, 'startActions' | 'actions'>) {
    render(<Modal open title="Map episodes" {...props}><p>Episodes</p></Modal>);
    const dialog = await screen.findByRole('dialog', { name: 'Map episodes' });
    return within(dialog.lastElementChild as HTMLElement);
  }

  it('puts the start actions before the actions', async () => {
    const footer = await footerOf({ startActions: <Button>New season</Button>, actions: <Button>Apply</Button> });

    expect(footer.getAllByRole('button').map((button) => button.textContent)).toEqual(['New season', 'Apply']);
  });

  it('shows the footer when it has only start actions', async () => {
    const footer = await footerOf({ startActions: <Button>New season</Button> });

    expect(footer.getByRole('button', { name: 'New season' })).toBeTruthy();
    expect(footer.queryByText('Episodes')).toBeNull();
  });
});

describe('Modal tabs', () => {
  it('keeps the dialog name when the title is hidden and selects the first tab', async () => {
    const dialog = await openTabbedModal();

    expect(dialog.getByText('Downloaded file').classList.contains('sr-only')).toBe(true);
    expectPanel(dialog, 'File', 'Torrent');
  });

  it('shows the panel for the tab that the user clicks', async () => {
    const dialog = await openTabbedModal();
    const tablist = within(dialog.getByRole('tablist'));

    fireEvent.click(tablist.getByRole('tab', { name: 'Torrent' }));

    expectPanel(dialog, 'Torrent', 'File');
  });

  it('moves focus and selects the next tab with the right arrow key', async () => {
    const dialog = await openTabbedModal();
    const tablist = within(dialog.getByRole('tablist'));
    const file = tablist.getByRole('tab', { name: 'File' });
    const torrent = tablist.getByRole('tab', { name: 'Torrent' });

    act(() => file.focus());
    fireEvent.keyDown(file, { key: 'ArrowRight' });
    await waitFor(() => expect(document.activeElement).toBe(torrent));

    expectPanel(dialog, 'Torrent', 'File');
  });
});
