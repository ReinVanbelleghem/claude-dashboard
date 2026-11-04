import { useMemo, useState } from "react";
import type { ReviewFile } from "../../api.ts";

/** The changed files as a folder tree, single-child folders collapsed into one row. */
type Node = { name: string; path: string; folders: Node[]; files: { file: ReviewFile; index: number }[] };

const STATUS: Record<string, { letter: string; cls: string }> = {
  added: { letter: "A", cls: "add" },
  removed: { letter: "D", cls: "del" },
  modified: { letter: "M", cls: "mod" },
  renamed: { letter: "R", cls: "ren" },
  copied: { letter: "C", cls: "ren" },
};

function build(files: { file: ReviewFile; index: number }[]): Node {
  const root: Node = { name: "", path: "", folders: [], files: [] };
  for (const entry of files) {
    const parts = entry.file.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let child = node.folders.find((f) => f.path === path);
      if (!child) node.folders.push((child = { name: parts[i], path, folders: [], files: [] }));
      node = child;
    }
    node.files.push(entry);
  }
  return root;
}

function compress(node: Node): Node {
  let cur = node;
  while (cur.files.length === 0 && cur.folders.length === 1 && cur.path !== "") {
    const only = cur.folders[0];
    cur = { ...only, name: `${cur.name}/${only.name}` };
  }
  return { ...cur, folders: cur.folders.map(compress) };
}

export function PrFileTree({
  files,
  currentIndex,
  commentCounts,
  onSelect,
}: {
  files: ReviewFile[];
  currentIndex: number;
  commentCounts: Map<string, number>;
  onSelect: (index: number) => void;
}) {
  const [filter, setFilter] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const tree = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matching = files.map((file, index) => ({ file, index })).filter((e) => !q || e.file.path.toLowerCase().includes(q));
    const root = build(matching);
    return { root: { ...root, folders: root.folders.map(compress) }, count: matching.length };
  }, [files, filter]);

  const toggle = (path: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const renderChildren = (node: Node, depth: number) => (
    <>
      {node.folders.map((f) => {
        const isClosed = closed.has(f.path) && !filter;
        return (
          <div key={f.path}>
            <button className="pr-tree-folder" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => toggle(f.path)}>
              <span className={`diff-caret ${isClosed ? "" : "open"}`} aria-hidden="true" />
              <span className="pr-tree-name">{f.name}</span>
            </button>
            {!isClosed && renderChildren(f, depth + 1)}
          </div>
        );
      })}
      {node.files.map(({ file, index }) => {
        const st = STATUS[file.status] ?? { letter: "~", cls: "" };
        const n = commentCounts.get(file.path) ?? 0;
        return (
          <button
            key={file.path}
            title={file.path}
            className={`pr-tree-file ${index === currentIndex ? "on" : ""} ${file.viewed ? "viewed" : ""}`}
            style={{ paddingLeft: 8 + depth * 12 + 14 }}
            onClick={() => onSelect(index)}
          >
            <span className={`pr-tree-status ${st.cls}`}>{st.letter}</span>
            <span className="pr-tree-name">{file.path.split("/").pop()}</span>
            {n > 0 && <span className="chip">{n}</span>}
            <span className="tok-add">+{file.additions}</span>
            <span className="tok-del">−{file.deletions}</span>
            <span className={`pr-tree-check ${file.viewed ? "on" : ""}`}>✓</span>
          </button>
        );
      })}
    </>
  );

  return (
    <div className="pr-tree">
      <input className="search" value={filter} placeholder="Filter files…" onChange={(e) => setFilter(e.target.value)} />
      <div className="pr-tree-list">{tree.count === 0 ? <div className="empty">No matching files</div> : renderChildren(tree.root, 0)}</div>
    </div>
  );
}
