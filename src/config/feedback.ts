/**
 * Day-1 stopgap bug reporting: a prefilled GitHub new-issue URL opened in the
 * user's browser (requires a GitHub account — acceptable stopgap only).
 *
 * TODO(_plans/50-crash-reporting-feedback.md section 2): the target repo must
 * be PUBLIC before shipping — if typeward/app stays private, point this at a
 * public issues-only repo instead. The real path (in-app form -> submit-feedback
 * edge function -> n8n triage -> private typeward/feedback repo) replaces this
 * with the account-site launch.
 *
 * Also allowlisted in src-tauri/capabilities/default.json (opener:allow-open-url).
 */
export const BUG_REPORT_ISSUE_URL = "https://github.com/typeward/app/issues/new";
