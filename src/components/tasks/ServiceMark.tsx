import type { LinkService } from "../../../shared/taskLinks.ts";

/**
 * The mark of the service a task's link points at, so a pull request, a Slack
 * thread and a Notion page can be told apart without reading an address.
 * Drawn here rather than fetched: a favicon request would tell a third party
 * which sites your tasks link to.
 */
export function ServiceMark({ service }: { service: LinkService }) {
  switch (service) {
    case "github":
      return (
        <svg className="svc-mark" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
        </svg>
      );
    case "slack":
      return (
        <svg className="svc-mark" viewBox="0 0 24 24" fill="none" strokeWidth="3.6" strokeLinecap="round" aria-hidden="true">
          <path d="M9 3.5v11" stroke="#36C5F0" />
          <path d="M15 9.5v11" stroke="#ECB22E" />
          <path d="M9.5 15h11" stroke="#E01E5A" />
          <path d="M3.5 9h11" stroke="#2EB67D" />
        </svg>
      );
    case "notion":
      return (
        <svg className="svc-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
          <path d="M9 16.5v-9l6 9v-9" />
        </svg>
      );
    case "gmail":
      return (
        <svg className="svc-mark" viewBox="0 0 24 24" fill="none" stroke="#EA4335" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3.5 18.5v-12l8.5 6.5 8.5-6.5v12" />
        </svg>
      );
    case "google":
      return (
        <svg className="svc-mark" viewBox="0 0 24 24" fill="none" stroke="#4285F4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <path d="M14 3v5h5" />
          <path d="M9 13h6M9 17h6" />
        </svg>
      );
    case "linear":
      return (
        <svg className="svc-mark" viewBox="0 0 24 24" fill="none" stroke="#5E6AD2" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="8.5" />
          <path d="M5 13.5 10.5 19M4 9.5 14.5 20M6.5 5.5l12 12" />
        </svg>
      );
    case "figma":
      return (
        <svg className="svc-mark" viewBox="0 0 24 24" fill="none" strokeWidth="2" aria-hidden="true">
          <circle cx="15" cy="12" r="3" stroke="#1ABCFE" />
          <path d="M9 3h3v6H9a3 3 0 0 1 0-6Z" stroke="#F24E1E" />
          <path d="M12 3h3a3 3 0 0 1 0 6h-3z" stroke="#FF7262" />
          <path d="M9 9h3v6H9a3 3 0 0 1 0-6Z" stroke="#A259FF" />
          <path d="M9 15h3v3a3 3 0 1 1-3-3Z" stroke="#0ACF83" />
        </svg>
      );
    default:
      return (
        <svg className="svc-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
          <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
        </svg>
      );
  }
}
