# AGENTS.md

## Design system

The UI uses only the components of the package `nebula`, in `packages/nebula`. The icons come from `lucide-react`.

- Import every UI component from `nebula`. Do not use a component from another source. Do not import Base UI (`@base-ui/react`) in `packages/webapp`.
- Do not make a new UI component. Do not copy a component of `nebula` and change it. Do not use a different component of `nebula` to get another look.
- Use each component with its documented props and slots only. Do not pass `className` or `style` to it.
- If `nebula` has no component for a need, or a component does not look right in a place, stop and tell the user in the chat. Do not work around it.
- Put the button that adds an item at the top right corner of its container. This holds for every container, also when the container has no items.
- Pages can use `className` on their own HTML elements for layout only (flex, grid, gap, width, margin, position, overflow). Do not use it for color, opacity, border, background, padding, text, or radius.
- `packages/webapp/src/components/` holds only compositions of `nebula` components that have no style of their own, such as `Link`, `Confirm`, and `LoadFailed`.
- The palette and the base style of the page are in `packages/webapp/src/theme/`. The theme of `nebula` is imported there.

## Layouts

- Align buttons to the right edge of their container.

## Plans

- Put plan markdown files in `.plans/` at the root of the repository. Git ignores this folder.

