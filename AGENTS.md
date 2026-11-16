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

## Tags

- The git tags give the version number. The version in `package.json` does not.
- When the user asks to publish a new tag, calculate the number from the commits between the highest tag and `HEAD`. Do not ask for it.
- Find the highest tag with `git tag --sort=-v:refname | head -1`. Read the commits of the range with `git log <tag>..HEAD --oneline`.
- Use Semantic Versioning, from the type of each commit:
  - A breaking change (a `!` before the colon, or a `BREAKING CHANGE` footer) increases the major number, and sets the minor and the patch to zero.
  - A `feat` commit increases the minor number, and sets the patch to zero.
  - Every other type increases the patch number.
- Make an annotated tag at `HEAD`. Use the subject of the `HEAD` commit as the message.
- Push the tag only. Push the branch only when the user asks for it.

