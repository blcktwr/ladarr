import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { ActionMenu, Activity, alert, Alerts, Backdrop, Background, Badge, Button, Checkbox, Confirm, Details, Divider, Dropdown, EmptyState, Field, Form, Gallery, Hint, List, Loading, Modal, Navbar, Pagination, Pane, Panel, Progress, Row, SearchField, Section, SideMenu, Spinner, SubMenu, Switch, Table, TagInput, Text, Thumbnail } from './index.ts';
import { BlockedIcon, DownloadIcon, ImportingIcon, PausedIcon, SearchingIcon, ValidatingIcon, WaitingIcon } from './index.ts';
import { Play, Plus, SlidersHorizontal } from 'lucide-react';

const variants = ['primary', 'ghost', 'danger', 'ghost-danger', 'link', 'link-inherit'];
const label = variant => variant[0].toUpperCase() + variant.slice(1).replace('-', ' ');

// The icons of the states of a target, with the colour that each state uses.
const indicators = [
  { label: 'Waiting', icon: WaitingIcon, tone: 'text-fog' },
  { label: 'Searching', icon: SearchingIcon, tone: 'text-accent' },
  { label: 'Downloading', icon: DownloadIcon, tone: 'text-accent' },
  { label: 'Validating', icon: ValidatingIcon, tone: 'text-accent' },
  { label: 'Importing', icon: ImportingIcon, tone: 'text-accent' },
  { label: 'Blocked', icon: BlockedIcon, tone: 'text-warning' },
  { label: 'Paused', icon: PausedIcon, tone: 'text-warning' },
];
// A list longer than the screen, so that it scrolls.
const many = Array.from({ length: 60 }, (_, index) => ({ value: `Option ${index + 1}` }));
const options = [{ value: 'Option 1' }, { value: 'Option 2' }, { value: 'Option 3' }, { value: 'Option 4', disabled: true }];
const languages = [
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'French' },
  { value: 'ja', label: 'Japanese' },
  { value: 'th', label: 'Thai' },
];

const TagInputSample = () => {
  const [tags, setTags] = useState(['en', 'th']);
  return (
    <Pane>
      <div className="flex flex-wrap items-start gap-6">
        <TagInput label="Languages" value={tags} onValueChange={setTags} options={languages} placeholder="Add a language" description="The languages of the aliases that a search asks." />
        <TagInput label="Disabled" value={['en']} onValueChange={() => {}} options={languages} disabled />
      </div>
    </Pane>
  );
};

// A grid of samples, with a caption over each column.
const grid = 'grid gap-x-8 gap-y-5 [&>span]:text-fog [&>span]:text-[12px]';
const h1 = 'text-ink text-[20px] font-semibold';

const Toggles = ({ of: Toggle }) => (
  <div className={`${grid} grid-cols-[repeat(4,max-content)] items-center`}>
    <span>Off</span><span>On</span><span>Disabled</span><span>Deactivated</span>
    <Toggle label="Label" />
    <Toggle label="Label" defaultChecked />
    <Toggle label="Label" disabled />
    <Toggle label="Label" deactivated />
  </div>
);

// The buttons of the modal close it.
const ModalSample = ({ width = 'md', children }) => {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      trigger={<Button>{children}</Button>}
      title="Title"
      width={width}
      actions={<><Button onClick={close}>Save</Button><Button variant="ghost" onClick={close}>Cancel</Button></>}
    >
      <Form><Field label="Label" placeholder="Placeholder" width="full" /></Form>
    </Modal>
  );
};

// The page opens the alert. Its action runs for a second and then closes it.
const ConfirmSample = () => {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const run = () => {
    setPending(true);
    setTimeout(() => { setPending(false); setOpen(false); }, 1000);
  };
  return (
    <Pane>
      <Button variant="danger" onClick={() => setOpen(true)}>Show</Button>
      <Confirm open={open} onOpenChange={setOpen} title="Title" confirm="Danger" onConfirm={run} pending={pending}>
        <Text>Message</Text>
        <Switch label="Label" />
      </Confirm>
    </Pane>
  );
};

// One button for each type. The warning has an action, so it stays until you close it.
// The blocker has no close button, so its action clears it.
// The queue button adds five alerts at once: they stack, and each one comes to the front as the one before it leaves.
const AlertSample = () => {
  const queue = () => {
    alert.success('Uploaded', 'The file is in the library.');
    alert.show('Indexing', 'The library is reading the new file.');
    alert.danger('No poster', 'The file has no poster.');
    alert.success('Indexed', 'The index is ready.');
    alert.warn('Check the file', 'One file needs a title.');
  };
  const warning = () => {
    const id = alert.warn('Title', 'Message', { action: { label: 'Action', onClick: () => alert.close(id) }, timeout: 0 });
  };
  const blocker = () => {
    const id = alert.blocker('Required', 'Set the value before you continue.', { action: { label: 'Clear', onClick: () => alert.close(id) } });
  };
  return (
    <Pane>
      <div className="flex flex-wrap gap-4">
        <Button onClick={() => alert.show('Title', 'Message')}>Neutral</Button>
        <Button onClick={() => alert.success('Title', 'Message')}>Success</Button>
        <Button onClick={warning}>Warning</Button>
        <Button onClick={() => alert.danger('Title', 'Message')}>Danger</Button>
        <Button onClick={blocker}>Blocker</Button>
        <Button onClick={queue}>Queue</Button>
      </div>
    </Pane>
  );
};

// The first poster is not selected, so its checkbox shows only on hover. The second is selected, so its checkbox always shows. The third is small. The fourth is extra small, for a row. The fifth loads.
const ProgressSample = () => (
  <Pane>
    <div className="grid gap-4 w-full max-w-80">
      <Progress label="Empty" value={0} />
      <Progress label="In progress" value={42} />
      <Progress label="Done" value={100} />
    </div>
  </Pane>
);

const ThumbnailSample = () => {
  const [first, setFirst] = useState(false);
  const [second, setSecond] = useState(true);
  return (
    <Gallery>
      <Thumbnail image={poster(200)} title="Title" year={2024} type="Movies" selected={first} onSelectedChange={setFirst} overlay={<><Button iconOnly aria-label="Play"><Play /></Button><Button iconOnly aria-label="Add"><Plus /></Button></>} />
      <Thumbnail image={poster(30)} title="A title that is long enough to be cut" year="2019–2023" type="Series" selected={second} onSelectedChange={setSecond} />
      <Thumbnail image={poster(120)} title="Title" year={2024} size="sm" />
      <Thumbnail image={poster(300)} title="Title" year={2024} size="xs" />
      <Thumbnail loading />
    </Gallery>
  );
};

// The actions of the action menu: one is off, and the last destroys data.
const actions = [{ label: 'Action 1' }, { label: 'Action 2' }, { label: 'Action 3', disabled: true }, { label: 'Danger', danger: true }];

// The columns and the rows of the table. The last column has the actions of each row.
const columns = [{ label: 'Column 1' }, { label: 'Column 2' }, { label: 'Column 3', align: 'end' }, { label: 'Actions', align: 'end', hideLabel: true }];
const rows = ['Item 1', 'Item 2', 'Item 3'].map((item, index) => ({ key: item, cells: [item, <Badge tone={index ? 'neutral' : 'success'}>Label</Badge>, 2024 - index, <ActionMenu label="More actions" items={actions} />] }));

// The pagination under the table. The page changes when you select a number or a key at the ends.
const PaginationSample = () => {
  const [page, setPage] = useState(2);
  return <Pagination aria-label="Pages" page={page} count={5} onPageChange={setPage} />;
};

const tasks = ['Task 1', 'Task 2', 'Task 3', 'Task 4', 'Task 5'];

// A dummy poster: a dark gradient of one hue, at 2:3.
const poster = hue => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2 3'><linearGradient id='g' x2='0' y2='1'><stop stop-color='hsl(${hue} 30% 50%)'/><stop offset='1' stop-color='hsl(${hue} 30% 22%)'/></linearGradient><rect width='2' height='3' fill='url(#g)'/></svg>`)}`;

// Dummy jobs for the navbar: each one runs, is marked as done and leaves, and then the next one starts. The list starts again at the end.
// Some jobs show a poster, and the others are text only.
const useDummyJobs = () => {
  const [step, setStep] = useState({ index: 0, done: false });
  useEffect(() => {
    const id = setTimeout(() => setStep(({ index, done }) => done ? { index: (index + 1) % tasks.length, done: false } : { index, done: true }), step.done ? 1000 : 2500);
    return () => clearTimeout(id);
  }, [step]);
  const left = tasks.length - step.index - 1;
  return { status: step.done ? 'Done' : 'Running', task: tasks[step.index], thumbnail: step.index % 2 ? undefined : poster(step.index * 70), queue: left ? `${left} in queue` : undefined, done: step.done };
};

// The activity of the sheet runs each task, strikes it when done and then shows the next one.
const ActivitySample = () => {
  const jobs = useDummyJobs();
  return <Activity {...jobs} />;
};

const pages = ['Item 1', 'Item 2', 'Item 3'].map(value => ({ value, label: value }));

// The page shows the other samples as the content of the items of the side menu.
const sections = [
  <Field label="Label" placeholder="Placeholder" />,
  <Switch label="Label" />,
  <Checkbox label="Label" />,
  <Dropdown options={options} defaultValue="Option 1" />,
].map((content, index) => ({ value: `Item ${index + 1}`, label: `Item ${index + 1}`, content }));

// The page puts the side menu, a button under it and the content of the selected item in its own layout.
const SideMenuSample = () => {
  const [value, setValue] = useState(sections[0].value);
  return (
    <div className="grid items-start gap-6 sm:grid-cols-[max-content_minmax(0,1fr)]">
      <div className="flex flex-col items-start gap-3">
        <SideMenu aria-label="Sections" value={value} onValueChange={setValue} items={sections} />
        <Button variant="ghost">Action</Button>
      </div>
      <Pane>{sections.find(section => section.value === value).content}</Pane>
    </div>
  );
};

// The navbar spans the whole sheet.
const Header = () => {
  const [page, setPage] = useState(pages[0].value);
  const [query, setQuery] = useState('');
  const jobs = useDummyJobs();
  return (
    <Navbar
      aria-label="Pages"
      items={pages}
      value={page}
      onChange={setPage}
      logo={<div className="size-8 rounded-full bg-stone-rim" aria-hidden="true" />}
      start={<Activity {...jobs} />}
    >
      <SearchField
        aria-label="Search"
        placeholder="Search"
        value={query}
        onChange={setQuery}
        trailing={
          <Panel
            label="Customize search"
            trigger={
              <button type="button" className="grid place-items-center size-8 rounded-sm outline-none text-fog cursor-pointer transition-[background-color,color] duration-200 ease-stone hover:bg-haze/8 hover:text-ink active:bg-dent active:duration-[60ms] [&>svg]:size-4.5">
                <SlidersHorizontal />
              </button>
            }
          />
        }
      />
    </Navbar>
  );
};

// The page is one column of the width of the navbar's content. The samples flow in columns, and the wide ones span all of them.
// The space after a section is padding: the columns drop a margin at the end of a column, before a wide section.
const card = 'grid gap-4 pb-14 break-inside-avoid';
const wide = `${card} [column-span:all]`;

// The veil covers the samples and not the navbar. It goes away by itself after two seconds, as a search would.
const Sheet = () => {
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!loading) return;
    const id = setTimeout(() => setLoading(false), 2000);
    return () => clearTimeout(id);
  }, [loading]);
  return (
    <div className="grid content-start @container">
      <Header />
      <Loading active={loading} label="Loading">
        <div className="columns-[34rem] gap-x-12 py-14 px-[max(20px,(100cqw_-_1200px)_/_2)]">
          <Pane className="mb-14 [column-span:all]">
            <Switch label="Light theme" onCheckedChange={checked => { document.documentElement.dataset.theme = checked ? 'light' : 'dark'; }} />
          </Pane>
          <section className={card}>
            <h1 className={h1}>Typography</h1>
            <Pane>
              <div className={`${grid} grid-cols-[repeat(2,max-content)] items-center`}>
                <span>Rest</span><span>Loading</span>
                <Text variant="title">Title</Text><Text variant="title" loading />
                <Text variant="heading">Heading</Text><Text variant="heading" loading />
                <Text>Body</Text><Text loading />
                <Text variant="small">Small</Text><Text variant="small" loading />
              </div>
            </Pane>
          </section>
          <section className={card}>
            <h1 className={h1}>Buttons</h1>
            <Pane>
              <div className="flex flex-wrap gap-4">{variants.map(variant => <Button key={variant} variant={variant}>{label(variant)}</Button>)}<Button iconOnly aria-label="Add"><Plus /></Button><ActionMenu label="More actions" items={actions} /></div>
            </Pane>
          </section>
          <section className={card}>
            <h1 className={h1}>Dropdown</h1>
            <Pane>
              <div className="flex flex-wrap items-end gap-6"><Dropdown label="Label" options={options} defaultValue="Option 1" /><Dropdown label="Label" size="sm" options={options} defaultValue="Option 1" /><Dropdown label="Label" options={many} defaultValue="Option 30" /></div>
            </Pane>
          </section>
          <section className={wide}>
            <h1 className={h1}>Input</h1>
            <Pane>
              <div className={`${grid} grid-cols-[repeat(3,max-content)] items-start`}>
                <span>Rest</span><span>Error</span><span>Action</span>
                <Field label="Label" placeholder="Placeholder" />
                <Field label="Label" placeholder="Placeholder" error="Error message" />
                <Field label="Label" placeholder="Placeholder" action={<Button variant="ghost">Action</Button>} />
              </div>
              <div className={`${grid} grid-cols-[repeat(4,max-content)] items-start`}>
                <span>Required</span><span>Description</span><span>Hidden label</span><span>Small</span>
                <Field label="Label" placeholder="Placeholder" required />
                <Field label="Label" placeholder="Placeholder" description="Description" />
                <Field label="Label" hideLabel placeholder="Placeholder" />
                <Field label="Label" placeholder="Placeholder" width="sm" />
              </div>
            </Pane>
          </section>
          <section className={wide}>
            <h1 className={h1}>Tag input</h1>
            <TagInputSample />
          </section>
          <section className={card}>
            <h1 className={h1}>Checkbox</h1>
            <Pane>
              <Toggles of={Checkbox} />
            </Pane>
          </section>
          <section className={card}>
            <h1 className={h1}>Switch</h1>
            <Pane>
              <Toggles of={Switch} />
            </Pane>
          </section>
          <section className={card}>
            <h1 className={h1}>Badge</h1>
            <Pane>
              <div className="flex flex-wrap gap-3">
                {['neutral', 'accent', 'success', 'warning', 'danger'].map(tone => <Badge key={tone} tone={tone}>{label(tone)}</Badge>)}
              </div>
            </Pane>
          </section>
          <section className={card}>
            <h1 className={h1}>Alert</h1>
            <AlertSample />
          </section>
          <section className={card}>
            <h1 className={h1}>Progress</h1>
            <ProgressSample />
          </section>
          <section className={wide}>
            <h1 className={h1}>Indicators</h1>
            <Pane>
              <div className="flex flex-wrap gap-x-10 gap-y-6">
                {indicators.map(({ label, icon: Icon, tone }) => (
                  <div key={label} className="flex items-center gap-2">
                    <Icon className={`size-6 ${tone}`} />
                    <span className="text-ink text-[15px]">{label}</span>
                  </div>
                ))}
              </div>
            </Pane>
          </section>
          <section className={card}>
            <h1 className={h1}>Thumbnail</h1>
            <ThumbnailSample />
          </section>
          <section className={card}>
            <h1 className={h1}>Loading</h1>
            <Pane><Button onClick={() => setLoading(true)}>Show</Button></Pane>
          </section>
          <section className={card}>
            <h1 className={h1}>Modal</h1>
            <Pane>
              <div className="flex flex-wrap gap-4"><ModalSample>Medium</ModalSample><ModalSample width="lg">Large</ModalSample><ModalSample width="xl">Extra large</ModalSample></div>
            </Pane>
          </section>
          <section className={card}>
            <h1 className={h1}>Confirm</h1>
            <ConfirmSample />
          </section>
          <section className={card}>
            <h1 className={h1}>Hint</h1>
            <Pane>
              <div className="flex items-center gap-1 text-ink text-[15px]">Label<Hint label="Label">Message</Hint></div>
            </Pane>
          </section>
          <section className={card}>
            <h1 className={h1}>Spinner</h1>
            <Pane>
              <div className="flex items-center gap-6"><Spinner label="Loading" size="sm" /><Spinner label="Loading" /><Spinner label="Loading" size="lg" /></div>
            </Pane>
          </section>
          <section className={card}>
            <h1 className={h1}>Empty state</h1>
            <Pane>
              <EmptyState>Message</EmptyState>
            </Pane>
          </section>
          <section className={wide}>
            <h1 className={h1}>Backdrop</h1>
            <Backdrop image={poster(200)}>
              <Thumbnail image={poster(30)} title="Title" year={2024} size="lg" />
              <div className="grid gap-2 pb-12"><Text variant="title">Title</Text><Text>Description</Text></div>
            </Backdrop>
            <Backdrop loading>
              <Thumbnail size="lg" loading />
              <div className="grid gap-2 pb-12"><Text variant="title" loading /><Text loading /></div>
            </Backdrop>
            <Backdrop />
          </section>
          <section className={wide}>
            <h1 className={h1}>Activity</h1>
            <ActivitySample />
          </section>
          <section className={wide}>
            <h1 className={h1}>Section</h1>
            <Pane>
              <Section title="Title" actions={<><Button>Save</Button><Button variant="ghost">Cancel</Button></>}>
                <Form>
                  <Field label="Label" placeholder="Placeholder" />
                  <Field label="Label" placeholder="Placeholder" width="full" />
                </Form>
              </Section>
            </Pane>
            <Pane>
              <Section title="Title" action={<Button><Plus />Action</Button>}>
                <EmptyState>Message</EmptyState>
              </Section>
            </Pane>
          </section>
          <section className={wide}>
            <h1 className={h1}>Details</h1>
            <Pane>
              <Details
                items={[
                  { label: 'Release', value: 'Movie.Name.2019.1080p.BluRay.x264-GRP', wide: true },
                  { label: 'Quality', value: 'BluRay 1080p' },
                  { label: 'Size', value: '11.7 GiB' },
                  { label: 'Indexer', value: 'Tracker' },
                ]}
              />
            </Pane>
          </section>
          <section className={wide}>
            <h1 className={h1}>Divider</h1>
            <Pane>
              <Text>Above</Text>
              <Divider />
              <Text>Below</Text>
            </Pane>
          </section>
          <section className={wide}>
            <h1 className={h1}>List</h1>
            <Pane>
              <List>
                <Row actions={<Button variant="ghost">Remove</Button>}>Item 1<Badge tone="success">Label</Badge></Row>
                <Row actions={<Button variant="ghost">Remove</Button>}>Item 2<Badge>Label</Badge></Row>
              </List>
            </Pane>
          </section>
          <section className={wide}>
            <h1 className={h1}>Table</h1>
            <Pane>
              <div className="grid justify-self-stretch gap-6">
                <Table title="Title" columns={columns} rows={rows} action={<Button><Plus />Action</Button>} />
                <PaginationSample />
              </div>
            </Pane>
            <Pane><Table aria-label="Table" columns={columns} loading /></Pane>
          </section>
          <section className={wide}>
            <h1 className={h1}>Side menu</h1>
            <SideMenuSample />
          </section>
          <section className={wide}><h1 className={h1}>Sub menu</h1><SubMenu aria-label="Sections" defaultValue="Item 1" items={pages} /></section>
        </div>
      </Loading>
    </div>
  );
};

createRoot(document.querySelector('main')).render(<StrictMode><Background><Alerts><Sheet /></Alerts></Background></StrictMode>);
