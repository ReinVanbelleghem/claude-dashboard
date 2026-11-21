/**
 * Ids of files that may live in a project's own folder: drawings and artifacts.
 *
 * A file in the old single folder goes by its bare name, as it always has. One
 * in a project's folder carries the project, so two projects can each hold an
 * `overview`. The id is opaque everywhere but here.
 */
const IN_PROJECT = /^p(\d+)@([\s\S]+)$/;

export const projectFileId = (projectId: number | null, name: string): string => (projectId === null ? name : `p${projectId}@${name}`);

export function parseProjectFileId(id: string): { projectId: number | null; name: string } {
  const m = IN_PROJECT.exec(id);
  return m ? { projectId: Number(m[1]), name: m[2]! } : { projectId: null, name: id };
}
