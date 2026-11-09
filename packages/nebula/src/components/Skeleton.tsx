// A flat shape that pulses in place of content while it loads. It is a part of a component with a loading prop, and the app does not use it by itself.
// It is a span, so that it can go in a heading or a paragraph. A screen reader does not read it.
// className gives it the size of the content.
export function Skeleton({ className = '' }: { className?: string }) {
  return <span aria-hidden="true" className={`block rounded-md bg-haze/10 animate-pulse motion-reduce:animate-none ${className}`} />;
}
