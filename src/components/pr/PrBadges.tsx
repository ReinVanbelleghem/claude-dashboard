import { linksBeyondTemplate, type PrSummary } from "../../api.ts";

/** Small status marks shared by the list rows and the PR header. */
const CI: Record<NonNullable<PrSummary["ciState"]>, { cls: string; label: string }> = {
  SUCCESS: { cls: "ok", label: "CI passing" },
  FAILURE: { cls: "bad", label: "CI failing" },
  ERROR: { cls: "bad", label: "CI error" },
  PENDING: { cls: "wait", label: "CI running" },
};

export function CiDot({ state, withLabel }: { state: PrSummary["ciState"]; withLabel?: boolean }) {
  const s = state ? CI[state] : { cls: "none", label: "No CI" };
  return (
    <span className={`pr-ci ${s.cls}`} title={s.label}>
      <i />
      {withLabel && <span>{s.label}</span>}
    </span>
  );
}

const DECISION: Record<NonNullable<PrSummary["reviewDecision"]>, { cls: string; label: string }> = {
  APPROVED: { cls: "ok", label: "Approved" },
  CHANGES_REQUESTED: { cls: "bad", label: "Changes requested" },
  REVIEW_REQUIRED: { cls: "", label: "Review required" },
};

export function ReviewBadge({ decision }: { decision: PrSummary["reviewDecision"] }) {
  if (!decision) return null;
  const d = DECISION[decision];
  return <span className={`pr-badge ${d.cls}`}>{d.label}</span>;
}

export function DraftBadge({ isDraft }: { isDraft: boolean }) {
  return isDraft ? <span className="pr-badge pending">Draft</span> : null;
}

export function NotionMark() {
  return (
    <svg aria-label="Notion" role="img" viewBox="0 0 24 24" className="pr-mark">
      <path
        fill="currentColor"
        d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z"
      />
    </svg>
  );
}

export function SlackMark() {
  return (
    <svg aria-label="Slack" viewBox="0 0 24 24" className="pr-mark">
      <path fill="#E01E5A" d="M5.04 15.17a2.53 2.53 0 1 1-2.52-2.53h2.52v2.53Zm1.27 0a2.53 2.53 0 0 1 5.05 0v6.31a2.53 2.53 0 1 1-5.05 0v-6.31Z" />
      <path fill="#36C5F0" d="M8.84 5.04a2.53 2.53 0 1 1 2.52-2.52v2.52H8.84Zm0 1.27a2.53 2.53 0 0 1 0 5.05H2.52a2.53 2.53 0 0 1 0-5.05h6.32Z" />
      <path fill="#2EB67D" d="M18.96 8.84a2.53 2.53 0 1 1 2.52 2.52h-2.52V8.84Zm-1.27 0a2.53 2.53 0 0 1-5.05 0V2.52a2.53 2.53 0 1 1 5.05 0v6.32Z" />
      <path fill="#ECB22E" d="M15.16 18.96a2.53 2.53 0 1 1-2.52 2.52v-2.52h2.52Zm0-1.27a2.53 2.53 0 0 1 0-5.05h6.32a2.53 2.53 0 0 1 0 5.05h-6.32Z" />
    </svg>
  );
}

/** Notion and Slack links from the description, minus the repository template's boilerplate. */
export function ContextLinks({ body, template }: { body: string; template: string }) {
  const links = linksBeyondTemplate(body, template);
  if (!links.length) return null;
  return (
    <span className="pr-links">
      {links.map((l) => (
        <a key={l.url} href={l.url} target="_blank" rel="noreferrer" title={l.url} className="pr-link">
          {l.kind === "notion" ? <NotionMark /> : <SlackMark />}
        </a>
      ))}
    </span>
  );
}
