/**
 * Where cloud-backed projects live on the remote.
 *
 * Every project Typeward creates on a cloud account goes into one shared
 * folder at the account base — `Typeward/<project name>` — created on demand.
 * Before this the user picked an arbitrary existing folder at the account
 * root, which meant a brand-new project could not be created at all unless
 * they first made a folder on the server by hand, and nothing tied a remote
 * folder to Typeward.
 *
 * Projects created under the old scheme keep working: the binding stored in
 * `integrations.cloudOrigin.remotePath` is an absolute-under-base path, so an
 * existing project keeps syncing against whatever folder it was bound to.
 */

import type { RemoteFolder } from "~/integrations/types";

/** The one folder, at the account base, that holds every Typeward project. */
export const CLOUD_PROJECTS_FOLDER = "Typeward";

/**
 * Turn a project name into a single safe remote path segment.
 *
 * The name is user-typed and ends up both in a URL path (percent-encoded in
 * Rust) and, on the next machine, in a folder listing. Separators and the
 * Win32-illegal set are folded to `-` so one name can never become two path
 * components or an unopenable folder; leading/trailing dots and spaces go
 * because Windows silently trims them, which would desync the two ends.
 */
export function remoteFolderSegment(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100)
    .replace(/^[.\s]+|[.\s]+$/g, "");
  return cleaned || "Untitled project";
}

/** The remote root a newly created project should sync against. */
export function remoteProjectFolder(name: string): RemoteFolder {
  const segment = remoteFolderSegment(name);
  return { id: `${CLOUD_PROJECTS_FOLDER}/${segment}`, name: segment };
}
