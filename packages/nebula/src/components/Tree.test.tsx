import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FileText, FileVideo } from 'lucide-react';
import { Tree, type TreeNode } from '../index.ts';

const ITEMS: TreeNode[] = [
  { key: 'Movie/info.nfo', name: 'info.nfo', size: '1000 B', icon: <FileText /> },
  { key: 'Movie/movie.mkv', name: 'movie.mkv', size: '2000 B', icon: <FileVideo /> },
  {
    key: 'Movie/Sample',
    name: 'Sample',
    children: [{ key: 'Movie/Sample/sample.mkv', name: 'sample.mkv', size: '1000 B', icon: <FileVideo /> }],
  },
];

const open = () => {
  render(<Tree aria-label="Files in the torrent" items={ITEMS} />);
  const folder = screen.getByRole('treeitem', { name: 'Sample' });
  folder.focus();
  return folder;
};

describe('Tree', () => {
  it('shows the files of the top level and keeps the folders closed', () => {
    render(<Tree aria-label="Files in the torrent" items={ITEMS} />);

    expect(screen.getByRole('tree', { name: 'Files in the torrent' })).toBeTruthy();
    expect(screen.getByRole('treeitem', { name: 'info.nfo 1000 B' })).toBeTruthy();
    expect(screen.getByRole('treeitem', { name: 'movie.mkv 2000 B' })).toBeTruthy();
    expect(screen.getByRole('treeitem', { name: 'Sample' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('treeitem', { name: 'sample.mkv 1000 B' })).toBeNull();
  });

  it('opens and closes a folder with a click, and keeps the files of the top level', () => {
    render(<Tree aria-label="Files in the torrent" items={ITEMS} />);
    const folder = screen.getByRole('treeitem', { name: 'Sample' });

    fireEvent.click(folder);
    expect(folder.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('treeitem', { name: 'sample.mkv 1000 B' })).toBeTruthy();

    fireEvent.click(folder);
    expect(folder.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('treeitem', { name: 'sample.mkv 1000 B' })).toBeNull();
    expect(screen.getByRole('treeitem', { name: 'info.nfo 1000 B' })).toBeTruthy();
  });

  it('opens and closes a folder with the keyboard', () => {
    const folder = open();

    fireEvent.keyDown(folder, { key: 'ArrowRight' });
    expect(folder.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(folder, { key: 'ArrowLeft' });
    expect(folder.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(folder, { key: 'Enter' });
    expect(folder.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(folder, { key: ' ' });
    expect(folder.getAttribute('aria-expanded')).toBe('false');
  });

  it('leaves the file rows without an action control', () => {
    open();

    const file = screen.getByRole('treeitem', { name: 'info.nfo 1000 B' });

    expect(file.querySelector('button, a')).toBeNull();
  });

  it('keeps a folder open when the items load again', () => {
    const { rerender } = render(<Tree aria-label="Files in the torrent" items={ITEMS} />);
    fireEvent.click(screen.getByRole('treeitem', { name: 'Sample' }));

    rerender(<Tree aria-label="Files in the torrent" items={[...ITEMS]} />);

    expect(screen.getByRole('treeitem', { name: 'Sample' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('treeitem', { name: 'sample.mkv 1000 B' })).toBeTruthy();
  });
});
