import { describe, expect, it } from 'vitest';
import { xmlToJson } from './xml.ts';

describe('xmlToJson', () => {
  it('nests the elements of a feed', () => {
    expect(xmlToJson('<rss><channel><item><title>Show</title></item></channel></rss>')).toEqual({ rss: { channel: { item: { title: 'Show' } } } });
  });

  it('keeps the attributes and repeats a name as a list', () => {
    expect(xmlToJson('<rss><item id="1"/><item id="2"/></rss>')).toEqual({ rss: { item: [{ '@id': '1' }, { '@id': '2' }] } });
  });

  it('reads a self-closing element with a namespace', () => {
    expect(xmlToJson('<torznab:attr name="seeders" value="12"/>')).toEqual({ 'torznab:attr': { '@name': 'seeders', '@value': '12' } });
  });

  it('keeps the text of an element next to its children', () => {
    expect(xmlToJson('<item>freeleech<title>Show</title></item>')).toEqual({ item: { '#text': 'freeleech', title: 'Show' } });
  });

  it('reads a CDATA block as text', () => {
    expect(xmlToJson('<description><![CDATA[<a href="https://x">more</a>]]></description>')).toEqual({ description: '<a href="https://x">more</a>' });
  });

  it('ignores the XML declaration and decodes the entities', () => {
    expect(xmlToJson('<?xml version="1.0"?><title>A &amp; B &lt;3</title>')).toEqual({ title: 'A & B <3' });
  });

  it('reads a cut body to the end', () => {
    expect(xmlToJson('<rss><channel><item><title>Show')).toEqual({ rss: { channel: { item: { title: 'Show' } } } });
  });

  it('gives nothing for a text that is not XML', () => {
    expect(xmlToJson('{"results":[]}')).toBeUndefined();
    expect(xmlToJson('')).toBeUndefined();
  });
});
