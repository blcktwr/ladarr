import { describe, expect, it } from 'vitest';
import { commentParts } from './links.ts';

describe('comment parts', () => {
  it('splits the links of a comment from the text around them', () => {
    expect(commentParts('See https://example.com/a and http://example.org/b for more')).toEqual([
      'See ',
      { href: 'https://example.com/a', text: 'https://example.com/a' },
      ' and ',
      { href: 'http://example.org/b', text: 'http://example.org/b' },
      ' for more',
    ]);
  });

  it('finds a link at the start and at the end of the comment', () => {
    expect(commentParts('https://example.com/a middle example.com/b')).toEqual([
      { href: 'https://example.com/a', text: 'https://example.com/a' },
      ' middle ',
      { href: 'http://example.com/b', text: 'example.com/b' },
    ]);
  });

  it('adds http to the href of a link without a scheme', () => {
    expect(commentParts('example.com/page')).toEqual([{ href: 'http://example.com/page', text: 'example.com/page' }]);
  });

  it('links a domain with several labels and no common top level domain', () => {
    expect(commentParts('del.icio.us/path')).toEqual([{ href: 'http://del.icio.us/path', text: 'del.icio.us/path' }]);
  });

  it('leaves a url glued to a word as text', () => {
    expect(commentParts('xhttps://example.com')).toEqual(['xhttps://example.com']);
  });

  it('leaves a magnet link as text', () => {
    const comment = 'magnet:?xt=urn:btih:0123456789abcdef';
    expect(commentParts(comment)).toEqual([comment]);
  });

  it('returns one text part when the comment has no link', () => {
    const comment = 'A comment with no link at all.';
    const parts = commentParts(comment);
    expect(parts).toEqual([comment]);
    expect(parts.map((part) => (typeof part === 'string' ? part : part.text)).join('')).toBe(comment);
  });

  it('keeps the punctuation after a link as text', () => {
    expect(commentParts('https://example.com/a).')).toEqual([
      { href: 'https://example.com/a', text: 'https://example.com/a' },
      ').',
    ]);
  });

  it('links an uppercase scheme and domain', () => {
    expect(commentParts('HTTPS://Example.COM/Path')).toEqual([
      { href: 'HTTPS://Example.COM/Path', text: 'HTTPS://Example.COM/Path' },
    ]);
  });
});
