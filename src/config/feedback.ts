/**
 * Bug reporting: a prefilled GitHub new-issue URL opened in the user's browser
 * (requires a GitHub account).
 *
 * The target repo must be PUBLIC for the link to work for users — if
 * typeward/app is private, point this at a public issues-only repo instead.
 *
 * Also allowlisted in src-tauri/capabilities/default.json (opener:allow-open-url).
 */
export const BUG_REPORT_ISSUE_URL = "https://github.com/typeward/app/issues/new";
