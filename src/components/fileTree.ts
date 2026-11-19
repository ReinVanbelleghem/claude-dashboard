export type TreeNode<T> = { name: string; path: string; folders: TreeNode<T>[]; files: T[] };

export function buildTree<T extends { path: string }>(files: T[]): TreeNode<T> {
  const root: TreeNode<T> = { name: "", path: "", folders: [], files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const path = node.path ? `${node.path}/${part}` : part;
      let next = node.folders.find((f) => f.path === path);
      if (!next) {
        next = { name: part, path, folders: [], files: [] };
        node.folders.push(next);
      }
      node = next;
    }
    node.files.push(file);
  }
  return squash(root);
}

function squash<T>(node: TreeNode<T>): TreeNode<T> {
  const folders = node.folders.map(squash).map((folder) => {
    let merged = folder;
    while (merged.files.length === 0 && merged.folders.length === 1) {
      const only = merged.folders[0]!;
      merged = { ...only, name: `${merged.name}/${only.name}` };
    }
    return merged;
  });
  return { ...node, folders };
}
