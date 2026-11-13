import { hotkeysCoreFeature, syncDataLoaderFeature } from '@headless-tree/core';
import { useTree } from '@headless-tree/react';
import { Folder } from 'lucide-react';
import { useEffect, useMemo, type ReactNode } from 'react';

export type TreeNode = {
  key: string;
  name: string;
  size?: string;
  icon?: ReactNode;
  children?: TreeNode[];
};

type TreeProps = { 'aria-label': string; items: TreeNode[] };

const focus = 'focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-3';
const iconSlot = 'mt-1 shrink-0 text-fog [&>svg]:size-3.5';

export function Tree({ 'aria-label': label, items }: TreeProps) {
  const nodes = useMemo(() => {
    const result = new Map<string, TreeNode>();
    const add = (children: TreeNode[]) => {
      for (const node of children) {
        if (!node.key || result.has(node.key)) throw new Error('Tree item keys must be non-empty and unique.');
        result.set(node.key, node);
        if (node.children) add(node.children);
      }
    };
    add(items);
    result.set('', { key: '', name: label, children: items });
    return result;
  }, [items, label]);
  const tree = useTree<TreeNode>({
    rootItemId: '',
    initialState: { expandedItems: [] },
    getItemName: (item) => item.getItemData().name,
    isItemFolder: (item) => item.getItemData().children !== undefined,
    dataLoader: {
      getItem: (id) => nodes.get(id)!,
      getChildren: (id) => nodes.get(id)?.children?.map((node) => node.key) ?? [],
    },
    features: [syncDataLoaderFeature, hotkeysCoreFeature],
  });

  useEffect(() => { tree.rebuildTree(); }, [tree, nodes]);

  return (
    <div role="region" aria-label={label} className="w-full min-w-0 font-sans text-ink">
      <div {...tree.getContainerProps(label)}>
        {tree.getItems().map((item) => {
          const { name, size, icon } = item.getItemData();
          const style = { paddingInlineStart: `${item.getItemMeta().level * 16}px` };
          return item.isFolder() ? (
            <button
              key={item.getId()}
              type="button"
              {...item.getProps()}
              onFocus={() => item.setFocused()}
              onKeyDownCapture={(event) => {
                if (!['Enter', ' ', 'ArrowRight', 'ArrowLeft'].includes(event.key)) return;
                event.preventDefault();
                event.stopPropagation();
                if (event.key === 'ArrowRight') item.expand();
                else if (event.key === 'ArrowLeft') item.collapse();
                else if (!event.repeat) {
                  if (item.isExpanded()) item.collapse();
                  else item.expand();
                }
              }}
              style={style}
              className={`flex items-start gap-2 mt-2 mb-1 cursor-pointer text-left text-[13px]/5 font-normal text-fog [overflow-wrap:anywhere] ${focus}`}
            >
              <span aria-hidden="true" className={iconSlot}><Folder /></span>
              <span className="min-w-0">{name}</span>
            </button>
          ) : (
            <div
              key={item.getId()}
              {...item.getProps()}
              aria-label={`${name} ${size ?? ''}`}
              onFocus={() => item.setFocused()}
              style={style}
              className={`grid grid-cols-[14px_minmax(0,1fr)_max-content] items-start gap-x-2 min-h-[34px] py-1.5 ${focus}`}
            >
              <span aria-hidden="true" className={iconSlot}>{icon}</span>
              <span className="min-w-0 text-[15px]/[22px] text-ink [overflow-wrap:anywhere]">{name}</span>{' '}
              <span className="text-[13px]/[22px] text-fog tabular-nums text-right whitespace-nowrap">{size}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
