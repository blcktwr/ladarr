# Nebula design guideline

This guideline gives the essence of Nebula, the rules that each component obeys, and how a component is made from the materials of the theme.

## Essence

Nebula is carved stone in fog. A control that you press is a key: a block of stone. A field is a flat area of the same stone. The page under them is a near-black haze.

- **Depth shows what is near.** The navbar is the nearest thing on the screen. Then come the slabs that lie over the page, such as a list or a panel. Then come the keys. The page is the farthest.
- **The light comes from above.** A block has a bright line on its top edge. Its thickness shows below its face, and it casts a shadow down.
- **The face of a block stays one even surface.** The relief is on the edges of the block, not on its face.
- **Dark and light are opposites.** In the dark theme, the nearest thing is the darkest. In the light theme, the stone is pale, the nearest thing is the brightest, and the shadows are softer.
- **The accent is white in the dark theme and black in the light theme.** The stone is gray. Red shows an error.

## Rules

- **A line on an edge means an error.** Do not put a border on a component to show its shape. Use the fill and the relief.
- **Fields are flat.** A field has no gradient, no border and no shadow.
- **Focus.** A key or a tab shows a 2px outline in the accent, outside its edge. A field shows a 3px ring in the accent, on the inner side of its edge. This ring has the same form as the error ring.
- **Pressed.** A pressed key sinks into the wall, and its label moves 2px down with its face. Thus the label stays in the center of the face.
- **On.** A key that is on, such as a checked checkbox, is made of the accent. It keeps the relief of a key and does not look pressed.
- **Disabled.** A disabled component fades to 35% opacity. It has no line.
- **Deactivated.** A deactivated component is disabled, and a diagonal line also strikes it out. The line is at 15°, in the text color, and goes a little past the edges. On a checkbox or a switch, the line also strikes the label. Set it with the `deactivated` prop of `Button`, `Field`, `Checkbox` and `Switch`.
- **Current.** In the navbar, the current item has a short bar of the accent on its top edge, with round bottom corners. The bar touches the top edge of the page. In a side menu, the bar touches the left edge of the list, with round right corners. In a sub menu, the current item is a `block`. The other items are `ghost`.
- **Errors.** An error shows in red with an icon. Thus a person can find the error without its color.
- **Tones.** A warning shows in amber with an icon. A success shows in green with an icon. Each tone has its own icon.
- **Icons.** A still icon is a Lucide icon. An icon that shows a state that continues, such as a download, is our own animated SVG in `src/components/indicators`: it takes the colour of the text, at 18px in a key or a tab, and it has no motion when the system asks for reduced motion. Do not draw a still icon in SVG.
- **Themes.** Each component gets its colors and shadows from the tokens of the theme. Thus each component works in the two themes.
- **Loading.** A component that shows data has a `loading` prop: `Thumbnail`, `Backdrop`, `Text` and `Table`. While it is on, the component shows its own shape as a skeleton, in place of its content. The skeleton is a flat tint of haze that pulses, with no relief. Do not put a skeleton on a page by itself.
- **Processing.** A button that starts a process shows the process on itself: it is `pending` or `loading`, with a wheel, and it is off. The container of the button does not show a spinner for the same process.
- **Motion.** A change of state uses the `ease-stone` curve and takes 200ms. A press takes 60ms. If the system asks for reduced motion, the keys have no transition.

## Materials

The materials are Tailwind classes in `src/theme/stone.ts`. Their colors and shadows are tokens in `src/theme.css`.

| Material | What it is | States |
|---|---|---|
| `key` | The base of each key: the label, its emboss, the transition, and the 2px drop of the label when pressed. Use it with `raised`, `ghost`, `sunk` or `on`. | |
| `block` | A raised block of stone that does not react, such as a poster. | |
| `bookmark` | A tag that hangs on a poster, such as the type of content: a key of the accent with a notch in its bottom edge. The shadow follows the notch. | |
| `raised` | A raised block of stone, made from `block`. | Lighter when the pointer is on it. Sunk into the wall when pressed. |
| `ghost` | A key with no block. | When the pointer is on it, it shows a recess. The recess is deeper when pressed. |
| `link` | A simple link: the label in the accent, with no block. | The line shows when the pointer is on it. |
| `plain` | A label with no block, no line and no bold. | No change. |
| `tab` | A key of the navbar, at 17px. Use it with `ghost`, or with `current` on the current tab. | |
| `current` | The current item of a tab list: a short bar of the accent on the top edge of the item, with round bottom corners. Use it in place of `ghost`. | |
| `currentSide` | The current item of a side menu: a short bar of the accent on the left edge of the list, with round right corners. Use it in place of `ghost`. | |
| `sunk` | A recess that stays pressed in, such as the selected option of a list. | |
| `pane` | The stone under the content of a page, where fields lie. It is a grid with space between its children. Its color differs from `--color-field` and from the page in the dark theme, so that neither gets lost. | |
| `danger` | A key made of red, for an action that destroys data. Its label is white. It keeps the relief of a key. | Lighter when the pointer is on it. Sunk when pressed. |
| `wheel` | A wheel that turns while something loads. | |
| `off` | A checkbox or a switch that is not on: a slot in the stone, deeper than the pane. | Lighter when the pointer is on it. |
| `on` | A key made of the accent, such as a checked checkbox. | Sunk when pressed. |
| `divider` | A line between two parts of a pane: a groove carved in the stone, deeper than the groove between the rows of a table, that runs the full width. | |
| `flat` | A field: a flat block of stone with no line on its edge. | Lighter when the pointer is on it. A ring in the accent for focus. A ring in red when invalid. |
| `chip` | A tag inside a field, such as a selected language. It is flat, so it is a value and not a key. | |
| `toggle` | A checkbox or a switch with its label. | Faded when disabled. Struck out too, label too, when deactivated. |

These surfaces are not in `stone.ts`:

- **Slab.** A slab lies over the page and casts a shadow on it. It uses `bg-slab` with `--slab-shadow` for a list below its trigger, or with `--panel-shadow` for a panel on the right edge.
- **Navbar.** The navbar is a slab across the full width. It uses `bg-navbar` with `--navbar-edge`.
- **Groove.** The groove between the rows of a table is carved in the pane. It uses `--groove`.
- **Page.** The `Background` component shows the page with `--backdrop`.

## How a component is made

A component has these layers:

1. A Base UI part gives the behavior and the accessibility.
2. A material from `stone.ts` gives the look.
3. The component adds its shape and size: the height, the padding and the corner radius.
4. The states come from the Base UI data attributes, such as `data-disabled`, `data-checked`, `data-invalid` and `data-popup-open`, and from the `pointed` and `pressed` variants.
5. The `className` prop is for layout only, such as a margin.

The components use the materials as follows:

- `ActionMenu`: a `key` with `raised` and the Lucide dots icon, at the size of an icon-only `Button`, so it fits in an `Actions` row. It opens a slab list of actions, as the list of a `Dropdown`. The trigger is `sunk` while the list is open. The actions are `ghost`. The label of a dangerous action is red. When you select an action, the list closes. Esc also closes it.
- `Activity`: a `tab` at the start of the navbar that shows the state of the queue and opens its page. It is `ghost`. Its values read as one sentence, at 15px, against its right edge. A small image of the task, such as a poster, can show after the state icon. A wheel turns at the left of the values while the queue runs. While the queue downloads, our `DownloadIcon` takes the place of the wheel. If the queue cannot continue, the warning icon, in amber, takes the place of the wheel. A page can name a state of its own, with an icon and a colour, such as a pause, and the icon takes the place of the wheel. When a task is done, a check takes the place of the wheel, and a line strikes out the values from left to right. Then the values move to the right as they fade out. The next task fades in.
- `Badge`: a flat pill with no relief, so that it does not look like a key. Its tone changes the fill: neutral, accent, success, warning or danger. The fill is a tint of the color of the tone, and the text is in that color. Only the fill of accent is solid. Its width can be fixed, so the badge keeps its size while its value changes length.
- `Button`: `key` with `raised` (primary), `ghost`, `danger`, `link`, `link-inherit` or `plain`. A `ghost` button can also have red text (ghost-danger), for an action that destroys data. A `link` button is a simple link: the label in the accent, with a line only when the pointer is on it. A `link-inherit` button takes the color of the text around it, for a link on a colored surface. A `plain` button has no block, no line and no bold. A link and a plain button have the size of their label. A pending or loading button shows a `wheel` and is off, but it is not struck out. A disabled button fades to 65% opacity, more than the other components, so it does not get lost in the pane.
- `Checkbox`: `key` with `off`, or with `on` when checked, in a `toggle`.
- `Switch`: `key` with `off`, or with `on` when on, in a `toggle`. It has no pressed look. Its thumb is a small round block of lit stone.
- `Field`: `flat`, with a label above it and a row for the error below it. A required field has a mark after its label. A description can show above the error. The label can be for a screen reader only. The width is small, medium or full. An action, such as a `Button`, can show at the right of the input, in the same row. Then the width is the width of the input and the action together.
- `FileField`: `flat`, with a label above it and the description and the error below it, as a `Field`. It shows an upload icon and the name of the file, or a placeholder, in the middle of its height. A click anywhere on the field opens the picker of the system. The input fills the field, so it takes the focus and the keys. The width is small, medium or full.
- `SearchField`: `flat`, with the Lucide search icon at its start.
- `Dropdown`: a `key` with `raised` as the trigger, and a slab list. The trigger is `sunk` while the list is open. The options are `ghost`, and the selected option is `sunk`. A label can show above the trigger, as the label of a `Field`. Then the dropdown also keeps the place of the error row of a `Field`. Thus a `Field` and a `Dropdown` side by side have the same height, and their controls align. An option can have a label that differs from its value. A long list is as tall as the space on the screen, and it scrolls inside. The `size` is `sm` or `md` (the default). A small dropdown has a shorter trigger and shorter options.
- `Indicators`: our own animated icons for the states of a target. `WaitingIcon` is an hourglass with one grain that falls, then the glass turns over. `SearchingIcon` is a magnifier that floats in all directions, with a line that sweeps the lens. `DownloadIcon` is a bold arrow that falls into the tray. `ValidatingIcon` is a file with a line that scans across its edges. `ImportingIcon` is a box with a gap in its side, where an arrow goes in and the gap closes behind it. `BlockedIcon` is a bold warning triangle with a brightness that breathes. `PausedIcon` is two bars that settle. They take the colour of the text, at 18px in a key or a tab. A state that continues moves in a loop. A pause moves once and then stays still. They have no motion when the system asks for reduced motion. Available and Cancelled are not indicators: they use a still Lucide icon.
- `Panel`: a slab on the right edge of the screen, over the veil of a `Modal`, which covers the whole app here. Its width is 360px (medium, the default), 45% of the window (large) or half of the window (extra large, such as for a log). It is never wider than the window. A panel that opens over another one takes 95% of the width of the panel under it, so a band of that panel stays visible on the left. A panel that opens over another one ignores its own size. It has a `ghost` close button, and its `title` shows in the same row. While it is open, the page under it does not take clicks or keys. Esc or a click on the veil closes it. A button opens it, or the page sets `open` and `onOpenChange`.
- `Progress`: a thin bar, 6px high, that shows how much of a known task is done. The track is a slot in the stone, and the fill is the accent. It has a label for a screen reader, and the value is from 0 to 100.
- `Modal`: a `pane` in the center of the screen, over the veil of `Loading`, which covers the whole app here. It has a title, a `ghost` close button, the content and a row of actions, with the spaces of a `Section`. Its width is 32rem (medium, the default), 48rem (large) or 64rem (extra large). On a narrow screen, it stays 1rem inside each edge. While it is open, the page under it does not take clicks or keys. Esc or a click on the veil closes it.
- `Confirm`: an alert that asks before an action that destroys data. It is a `Modal` with no trigger and no close button. The page opens it. It has a title that asks the question, the content, and a row of buttons at its right edge: a `ghost` Cancel button, and then a `danger` confirm button at the far right. Cancel has the focus when it opens, so Enter does not destroy data. A screen reader reads the title and the content at once. Cancel or Esc closes it. A click on the veil does not close it. The confirm button does not close it. The page closes it when the action ends.
- `SideMenu`: a slab list of the sections of a page, such as the parts of a settings page, as the list of a `Dropdown`. The items are `ghost`, and the selected item is `currentSide`. The arrow keys move between the items. The page shows the content of the selected section, and it puts the list and the content in its own layout.
- `SubMenu`: a slab row of the sections inside a page, as the list of a `SideMenu`. The items are `ghost`, and the selected item is a `block`. A `count` on an item shows the number of items of the section in a `Badge` at the end of its key, with a fixed width, so a change of the count does not move the items. With `fill`, the row fills the width of its container and the items share it. The page shows the content of the selected section. On a narrow screen, the items go on more than one row.
- `Navbar`: the navbar slab, with a `tab` for each section at the right. The start of the top row is at the left, and the logo is in the middle. The current section is `current`.
- `Pane`: a container with the `pane` material. No component lies on the page without a container, but a `Gallery`, a `Thumbnail` or a `Backdrop` can.
- `Hint`: a small round `ghost` key with the Lucide help icon, after a text, such as the name of a value in a `Table`. It shows a short text in a slab, as the list of an `ActionMenu`. The text shows when the pointer is on the key, when the key gets the focus from the keyboard, or after a click. Esc closes it. A screen reader reads the text as the description of the key.
- `Spinner`: a `wheel`, small, medium or large, with a label for a screen reader.
- `Loading`: a veil over the content while it loads, such as during a search, with a large `Spinner` in its center. It goes around the content and not around the navbar, so the navbar stays free. While the veil shows, the content under it does not take clicks or keys.
- `EmptyState`: a message in the center, in the color of fog, for a list with no rows.
- `Alerts`: a queue of alerts at the bottom right of the window, over the page. Put it around the app. Then show an alert from any TypeScript file with `alert.show`, `alert.success`, `alert.warn`, `alert.danger` or `alert.blocker`. Each method takes a title, an optional message, and options. The options are `timeout`, `action`, `id` and `close`. `close: false` hides the close button. `alert.close(id)` closes an alert, and `alert.close()` closes all alerts. A type of success, warning or danger makes it a block of the stone of its tone, with the relief of a key and the icon of the tone in the color of its text. Without a type, it is a slab. It has a title, a message, an optional action as a `link-inherit`, and a close button. The alerts stack: the oldest is in front at the bottom, and up to two alerts that wait show as edges above it, in the stone of their tone. A new alert goes to the back of the queue. Only the front alert has a time. It goes away after 5 seconds, and then the next alert comes to the front and starts its time. Thus each alert shows for its own time, in the order that it arrived. If the person must do something, set its timeout to 0: it stays in front, and the queue waits. While the pointer or the focus is on it, the time stops. The stack shows 3 alerts at most, and the time is 5 seconds. Set them with the `limit` and `timeout` props of `Alerts`. A blocker stays in the stack until the condition that made it ends, and it has no close button and no swipe. While a `Modal`, a `Confirm` or a `Panel` is open, no alert shows and no time runs. The alerts come back when it closes.
- `Text`: the type scale. A `title` is the title of a page: an `h1` at 28px, semibold. A `heading` is the title of a part of a page: an `h2` at 20px, semibold. `body` is the text of a paragraph, at 15px. `small` is a short text in the color of fog, such as a year, at 13px. While `loading` is on, a bar of one line shows in place of the text.
- `Section`: a part of a page with no box. It has a title, the content, and a row of actions at the end. Its content lies at the start of its column, so a control keeps its own width. A control, such as a `Button` that adds an item, can show at the right of the title, as in a `Table`. It also shows when the content is an `EmptyState`.
- `Details`: a list of label and value pairs, with the layout of a field: the label above the value. The values fill as many columns as the width fits. A `wide` item takes the full row, for a long value such as the name of a release.
- `Divider`: a line between two parts of a pane, deeper than the groove between the rows of a `Table`: a dark line with the light from above under it, both running the full width. It is 2px high, and it fills its container.
- `Form`: a form of fields, with space between them. It fills the width of its column, so a field can shrink to fit a narrow screen.
- `Actions`: a row of buttons. On a narrow screen it goes on more than one row.
- `List`: a list of rows, with space between them.
- `Row`: a row of a list. The text and the badges are at the start, and the actions are at the end. On a narrow screen the actions go below the text.
- `Table`: a table of data on a pane. It can have a title above it, as a `Section`. A control, such as a `Button` that adds a row, can show at the right of the title. The row of the title is as tall as the control, so the control does not touch the labels of the columns. It goes past the padding of the pane to the two edges of the pane. Thus the groove between two rows goes across the full pane. The groove is a dark line with a bright line under it, as the light comes from above. The text of the first and the last column aligns with the content of the pane. The labels of the columns are 15px, weight 550, in the color of fog. A row is 64px high, so an `ActionMenu` fits in it. A column can put its cells at its end, such as for a number or an `ActionMenu`. The label of a column can be for a screen reader only. A column can have a fixed width, such as 6rem. A table with a width uses a fixed layout: the columns do not change with the content. A row can have a click that opens something, such as the episodes of a series. The pointer shows it, and a click on a control inside the row keeps the action of the control. The other columns share the rest. A wide table scrolls inside the pane. Each row has `data-row` with its key, so a check can find it. While `loading` is on, three rows show a bar in each cell. With `animated`, a row enters from below and leaves toward the top in 200ms with the `ease-stone` curve, and the detail under it does too. The top row is the row that leaves first.
- `TagInput`: a `flat` field with a label above it, a row of `chip` tags, and a text input. Each chip has a `ghost` cross that removes it. The list of options is a slab, as the list of a `Dropdown`: its items are `ghost`, and the selected item is `sunk`. The list filters as the person types. Enter adds the highlighted option, the option that matches the text, or the text itself as a new tag. The list says `No options.` when no option matches, unless `emptyText` gives another text. A description and an error keep the place of the error row of a `Field`. The width is small, medium or full.
- `Pagination`: the pages of a table, below it. The previous and the next page are `ghost` keys with the Lucide chevron icon, at the two ends. A page number is a `ghost` key, and the current page is `sunk`. A key at an end fades when it cannot go past the first or the last page.
- `Thumbnail`: the poster of a film or a series, at 2:3, as a `block`. Its width is 80px (extra small, for a row of a list that has its own data), 128px (small), 160px (medium, for a list of posters) or 224px (large, for a single poster, such as on a `Backdrop`). The text under it has the same size at each width. While the image loads, the mark of the app shows on the block at 30% opacity under the skeleton, and then the image fades in. Without an image, the mark stays. While `loading` is on, the skeleton shows on the block, and a bar shows in place of the title and of the year. The overlay and the checkbox do not show. An optional overlay, such as icon buttons, shows over the poster on a scrim when the pointer or the focus is on the poster. A `Checkbox` at the top right corner of the poster can select it. The checkbox shows when the pointer or the focus is on the poster. While it is on, it always shows. Ctrl or Cmd and a click on the poster also select it. Its title and its year are under it. The title has one row, and a long title is cut, so the years of a row of posters stay on one line. Its type, such as Movies, Series or Anime, shows as a `bookmark` at the top left corner of the poster, with its text from top to bottom. The bookmark hangs from the top edge, and its bottom edge has a notch.
- `Backdrop`: a banner at the top of the page of a film or a series. It lies on the page without a pane, and it fills the width of its parent. It is a `block`, with a wide image that is cropped at the center. A gradient of the page color over the image dims it, more at the bottom, so the content over it is easy to read. The bottom of the banner fades into the page. While the image loads, the skeleton shows on the block, and then the image fades in. Without an image, the bare block stays. While `loading` is on, the skeleton shows on the block, and its content, such as a `Thumbnail` and a `Text`, can load too. Its content, such as a `Thumbnail` and a title, lies over it at the bottom left.
- `Gallery`: a group of thumbnails, such as a catalog or a cast. The thumbnails go on more than one row, with 24px between them on a row and 32px between the rows. The thumbnails align to the left of the row, also when the row is not full. Put a group of thumbnails in a `Gallery`, not in `Actions` or in a layout of the app, so the space is the same on each page.
- `Background`: the page. Its haze has the size of the window, so it stays the same on a tall page and on a short page. It does not move when the page scrolls.

## Measures

- **Font.** Inter Variable.
- **Text.** A key label is 15px, weight 550, with the emboss. The text of a field is 15px. The label of a field is 13px, weight 550. A navbar tab is 17px, weight 550.
- **Heights.** A key and a field are 44px. A navbar tab is 40px. A checkbox is 32px. A switch is 60 × 32px.
- **Icons.** An icon in a key or a tab is 18px.

## Structure

- `src/theme.css`: the tokens. The colors are `--color-*` in `@theme static`. The materials are CSS variables in `:root`. `[data-theme=light]` sets the colors and the materials again for the light theme. The file also has the `pointed` and `pressed` variants and the `struck` utility.
- `src/theme/stone.ts`: the materials.
- `src/components/`: one file for each component.
- `src/index.ts`: the public exports.
- `src/main.jsx`: the sheet. It shows each component in each state. `data-state=hover` and `data-state=press` force the states on the sheet.

## Add a component

1. Use a Base UI part for the behavior, if one exists.
2. Use a material from `src/theme/stone.ts`.
3. If no material is correct for the role of the component, add a material to `stone.ts` and its tokens to `theme.css` for the two themes.
4. Do not put a color value or a shadow value in the component. Use the tokens.
5. Export the component from `src/index.ts`.
6. Add the component to the sheet in each of its states.
7. Look at the component on the page in the two themes. Make sure that its shape shows clearly.
