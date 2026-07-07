/**
 * Display-only plan facts for the "What's in Pro" surfaces (ProDialog,
 * onboarding plan step, Account section).
 *
 * The transactional truth — live prices, trial terms, billing — is
 * account.typeward.com / Stripe. These constants are marketing copy only;
 * keep them in sync when the catalog changes there.
 */

/** Account + billing page on the Typeward website (allowlisted in capabilities). */
export const ACCOUNT_BILLING_URL = "https://account.typeward.com";

export const PRO_PRICING_LINE =
  "9 USD/month or 90 USD/year — 14-day free trial, no card required";

/** The Pro feature matrix as shown to users. Mirrors the entitlement keys
 * in `KNOWN_ENTITLEMENT_KEYS` at category granularity. */
export const PRO_FEATURES: ReadonlyArray<{ label: string; detail: string }> = [
  { label: "Typst", detail: "Create and compile Typst projects alongside LaTeX" },
  {
    label: "References",
    detail: "Zotero (local and web), Mendeley, and DOI lookup",
  },
  {
    label: "Git and GitHub",
    detail: "Commit, push, pull, clone, and Overleaf import",
  },
  { label: "AI assistant", detail: "Claude, GPT, Gemini, or local Ollama" },
  { label: "Grammar checking", detail: "On-device grammar and spelling via Harper" },
  { label: "Cloud sync", detail: "Dropbox and WebDAV, local-first" },
  { label: "Custom templates", detail: "Save and reuse unlimited project templates" },
];
