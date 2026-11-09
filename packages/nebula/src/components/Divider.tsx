import { Separator } from '@base-ui/react/separator';
import { divider } from '../theme/stone.ts';

// A line between two parts of a pane. It is a groove carved in the stone, deeper than the groove between the rows of a
// Table, so that the two parts read apart at a glance. It fills its container.
// className is for layout only, such as a margin.
export function Divider({ className = '' }: { className?: string }) {
  return <Separator className={`${divider} ${className}`} />;
}
