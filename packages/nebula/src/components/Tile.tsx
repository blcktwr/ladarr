import { key, pressed, raised } from '../theme/stone.ts';

type TileProps = {
  // The image of the tile. Without one, the tile shows its label.
  image?: string;
  // The name of the tile, for a screen reader and when it has no image.
  label: string;
  selected?: boolean;
  onSelectedChange: (selected: boolean) => void;
  // className is for layout only, such as a margin.
  className?: string;
};

// A square tile with an image, such as the logo of a streaming service, that a person selects. It takes the width of its
// container, so the block of the tile is the whole item. The stone shows around the image, and the tile presses in while
// it is selected. The image keeps the round corners of the tile.
export function Tile({ image, label, selected = false, onSelectedChange, className = '' }: TileProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      onClick={() => onSelectedChange(!selected)}
      className={`${key} ${selected ? pressed : raised} block w-full aspect-square p-1.5 rounded-md cursor-pointer overflow-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-3 ${className}`}
    >
      {image ? <img src={image} alt="" loading="lazy" decoding="async" className="size-full rounded-sm object-contain" /> : <span className="grid size-full place-items-center text-[11px]/3 text-center">{label}</span>}
    </button>
  );
}
