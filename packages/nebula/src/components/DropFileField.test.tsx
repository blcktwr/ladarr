import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DropFileField } from '../index.ts';

const torrent = new File(['data'], 'Selected.TORRENT');
const backup = new File(['data'], 'backup.zip', { type: 'application/zip' });

const drop = (field: HTMLElement, files: File[]) => fireEvent.drop(field, { dataTransfer: { types: ['Files'], files } });

describe('DropFileField', () => {
  it('accepts the file from the picker and from the drop area', () => {
    const onFile = vi.fn();
    render(<DropFileField label="Torrent file" accept=".torrent,application/x-bittorrent" onFile={onFile} />);
    const field = screen.getByLabelText('Torrent file');

    fireEvent.change(field, { target: { files: [torrent] } });
    expect(drop(field, [torrent])).toBe(false);

    expect(onFile.mock.calls).toEqual([[torrent], [torrent]]);
    expect(field).toHaveProperty('accept', '.torrent,application/x-bittorrent');
  });

  it('does not select a file if the drop has a different type or more than one file', () => {
    const onFile = vi.fn();
    render(<DropFileField label="Torrent file" accept=".torrent" onFile={onFile} />);
    const field = screen.getByLabelText('Torrent file');

    expect(drop(field, [backup])).toBe(false);
    expect(drop(field, [torrent, torrent])).toBe(false);

    expect(onFile).not.toHaveBeenCalled();
  });

  it('does not select a file while the field is disabled', () => {
    const onFile = vi.fn();
    render(<DropFileField label="Torrent file" disabled onFile={onFile} />);
    const field = screen.getByLabelText('Torrent file');

    drop(field, [torrent]);

    expect(field).toHaveProperty('disabled', true);
    expect(onFile).not.toHaveBeenCalled();
  });
});
