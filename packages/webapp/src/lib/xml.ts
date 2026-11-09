// A small XML reader for the log view. A feed holds no more than a name, attributes and text, and Node has no DOM.
// An element becomes an object: the attributes as @name, the text as #text, and a repeated name as a list.

type XmlValue = string | { [key: string]: XmlValue } | XmlValue[];
type XmlNode = { name: string; value: XmlValue };

const isSpace = (char: string) => char === ' ' || char === '\n' || char === '\t' || char === '\r';
const isStop = (char: string) => isSpace(char) || char === '/' || char === '>' || char === '=';

const named = (name: string) => {
  switch (name) {
    case 'amp':
      return '&';
    case 'lt':
      return '<';
    case 'gt':
      return '>';
    case 'quot':
      return '"';
    case 'apos':
      return "'";
    default:
      return undefined;
  }
};

// The five named entities and the numeric ones.
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, code: string) => {
    if (code[0] !== '#') return named(code) ?? whole;
    const point = code[1] === 'x' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
  });

export function xmlToJson(text: string): unknown {
  const source = text.trim();
  if (!source.startsWith('<')) return undefined;

  let at = 0;
  const end = source.length;

  // Moves past the first marker, or to the end when the body is cut.
  const skipPast = (marker: string) => {
    const found = source.indexOf(marker, at);
    at = found < 0 ? end : found + marker.length;
  };

  const skipSpace = () => {
    while (at < end && isSpace(source[at]!)) at++;
  };

  // The declaration, the comments and the processing instructions carry no data.
  const skipIgnored = () => {
    for (;;) {
      skipSpace();
      if (source.startsWith('<?', at)) skipPast('?>');
      else if (source.startsWith('<!--', at)) skipPast('-->');
      else if (source.startsWith('<!', at)) skipPast('>');
      else return;
    }
  };

  const readName = () => {
    const start = at;
    while (at < end && !isStop(source[at]!)) at++;
    return source.slice(start, at);
  };

  // A value in quotes, with its entities decoded.
  const readQuoted = () => {
    const quote = source[at];
    if (quote !== '"' && quote !== "'") {
      const start = at;
      while (at < end && !isSpace(source[at]!) && source[at] !== '>') at++;
      return decode(source.slice(start, at));
    }
    at++;
    const found = source.indexOf(quote, at);
    const value = source.slice(at, found < 0 ? end : found);
    at = found < 0 ? end : found + 1;
    return decode(value);
  };

  const addChild = (node: Record<string, XmlValue>, name: string, value: XmlValue) => {
    if (!Object.hasOwn(node, name)) {
      node[name] = value;
      return;
    }
    const existing = node[name]!;
    node[name] = Array.isArray(existing) ? [...existing, value] : [existing, value];
  };

  // A text alone is the element. Next to children or attributes, it goes to #text.
  const valueOf = (node: Record<string, XmlValue>, text: string): XmlValue => {
    const trimmed = text.trim();
    if (!trimmed) return Object.keys(node).length ? node : '';
    if (!Object.keys(node).length) return trimmed;
    return { '#text': trimmed, ...node };
  };

  const parseElement = (): XmlNode => {
    at++; // past '<'
    const name = readName();
    const node: Record<string, XmlValue> = {};

    for (;;) {
      skipSpace();
      if (at >= end) return { name, value: valueOf(node, '') };
      const char = source[at]!;
      if (char === '>') {
        at++;
        break;
      }
      if (char === '/') {
        at = Math.min(end, at + 2); // past '/>'
        return { name, value: valueOf(node, '') };
      }
      const field = readName();
      if (!field) {
        at++; // a stray character
        continue;
      }
      skipSpace();
      if (source[at] === '=') {
        at++;
        skipSpace();
        node[`@${field}`] = readQuoted();
      } else {
        node[`@${field}`] = '';
      }
    }

    const chunks: string[] = [];
    for (;;) {
      if (at >= end) break;
      if (source.startsWith('</', at)) {
        skipPast('>');
        break;
      }
      if (source.startsWith('<![CDATA[', at)) {
        const found = source.indexOf(']]>', at);
        chunks.push(source.slice(at + 9, found < 0 ? end : found));
        at = found < 0 ? end : found + 3;
        continue;
      }
      if (source.startsWith('<!--', at) || source.startsWith('<?', at) || source.startsWith('<!', at)) {
        skipIgnored();
        continue;
      }
      if (source[at] === '<') {
        const child = parseElement();
        addChild(node, child.name, child.value);
        continue;
      }
      const found = source.indexOf('<', at);
      chunks.push(decode(source.slice(at, found < 0 ? end : found)));
      at = found < 0 ? end : found;
    }
    return { name, value: valueOf(node, chunks.join('')) };
  };

  skipIgnored();
  if (source[at] !== '<') return undefined;
  const root = parseElement();
  return { [root.name]: root.value };
}
