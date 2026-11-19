const PREFIX = "art:";

/** The id an artifact goes by wherever sessions are opened: drawer, tile, page and sidebar. */
export const artifactKey = (slug: string) => `${PREFIX}${slug}`;
export const isArtifactKey = (key: string | null | undefined): key is string => !!key && key.startsWith(PREFIX);
export const artifactSlugOf = (key: string) => key.slice(PREFIX.length);
