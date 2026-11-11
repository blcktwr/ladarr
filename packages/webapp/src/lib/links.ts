// A link in the comment of a torrent, in the same cases as qBittorrent: with a scheme, with a common top level domain
// and no scheme, or with two domain labels before the last one. A link starts the text or follows whitespace.
const LINK = /(?<=\s|^)(?:https?:\/\/(?:[a-zA-Z0-9_-]+\.)+(?:[a-zA-Z0-9?%=&/_.#:;-])+|(?:[a-zA-Z0-9_-]+\.)+(?=aero|arpa|asia|biz|cat|com|coop|edu|gov|info|int|jobs|mil|mobi|museum|name|net|org|pro|ro|ru|tel|travel)(?:[a-zA-Z0-9?%=&/_.#:;-])+|(?:[a-zA-Z0-9_-]+\.){2,}[a-zA-Z]{2,}(?:[a-zA-Z0-9?%=&/_.#:;-])*)/gi;

export type CommentPart = string | { href: string; text: string };

// The comment of a torrent, with each link as its own part. A link without a scheme opens with http.
export function commentParts(text: string): CommentPart[] {
  const parts: CommentPart[] = [];
  let at = 0;
  for (const match of text.matchAll(LINK)) {
    if (match.index > at) parts.push(text.slice(at, match.index));
    const url = match[0];
    parts.push({ href: /^https?:\/\//i.test(url) ? url : `http://${url}`, text: url });
    at = match.index + url.length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}
