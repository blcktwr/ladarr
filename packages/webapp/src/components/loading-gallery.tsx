import { Gallery, Thumbnail } from 'nebula';

// The thumbnails of a group while its data loads.
export function LoadingGallery({ size = 'md', count = 12 }: { size?: 'sm' | 'md'; count?: number }) {
  return (
    <Gallery>
      {Array.from({ length: count }, (_, index) => (
        <Thumbnail key={index} size={size} loading />
      ))}
    </Gallery>
  );
}
