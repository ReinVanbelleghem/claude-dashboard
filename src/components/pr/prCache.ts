import { prApi, type PrRef } from "../../api.ts";

const store = new Map<string, unknown>();
const MAX_ENTRIES = 200;

export type PrPart = "detail" | "overview" | "files" | "threads" | "commits";

const keyOf = (pr: PrRef, part: PrPart) => `${pr.owner}/${pr.repo}/${pr.number}:${part}`;

export const recall = <T,>(pr: PrRef, part: PrPart): T | undefined => store.get(keyOf(pr, part)) as T | undefined;

export function remember<T>(pr: PrRef, part: PrPart, value: T): T {
  const key = keyOf(pr, part);
  store.delete(key);
  store.set(key, value);
  if (store.size > MAX_ENTRIES) store.delete(store.keys().next().value!);
  return value;
}

const LOADERS: Record<Exclude<PrPart, "detail">, (pr: PrRef) => Promise<unknown>> = {
  overview: (pr) => prApi.overview(pr),
  files: (pr) => prApi.files(pr),
  threads: (pr) => prApi.threads(pr).then((r) => r.threads),
  commits: (pr) => prApi.commits(pr).then((r) => r.commits),
};

export function warm(pr: PrRef, parts: Exclude<PrPart, "detail">[]) {
  for (const part of parts) {
    if (recall(pr, part) !== undefined) continue;
    LOADERS[part](pr)
      .then((value) => remember(pr, part, value))
      .catch(() => {});
  }
}
