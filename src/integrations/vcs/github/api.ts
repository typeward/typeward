/**
 * GitHub REST API wrappers used by the clone picker and the
 * "Publish to GitHub" flow. Every call uses the stored device-flow
 * token via the keyring `authRef`.
 */

import { httpRequest } from "~/integrations/http";

const API_ROOT = "https://api.github.com";
const KEYRING_SERVICE = "git.github.com";
const KEYRING_ACCOUNT = "x-access-token";

export interface GitHubRepo {
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  sshUrl: string;
}

interface RepoDto {
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  default_branch: string;
  clone_url: string;
  ssh_url: string;
}

const auth = {
  service: KEYRING_SERVICE,
  account: KEYRING_ACCOUNT,
  header: "Authorization",
  prefix: "Bearer ",
};

const baseHeaders = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

export async function listRepos(perPage = 100): Promise<GitHubRepo[]> {
  const res = await httpRequest({
    method: "GET",
    url: `${API_ROOT}/user/repos?per_page=${perPage}&sort=updated`,
    headers: baseHeaders,
    authRef: auth,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`GitHub /user/repos failed (status ${res.status}): ${res.body}`);
  }
  const dtos = JSON.parse(res.body) as RepoDto[];
  return dtos.map(toRepo);
}

export interface CreateRepoOptions {
  name: string;
  description?: string;
  private?: boolean;
  /** Initialize with a README so the new repo has a default branch. */
  autoInit?: boolean;
}

export async function createRepo(opts: CreateRepoOptions): Promise<GitHubRepo> {
  const res = await httpRequest({
    method: "POST",
    url: `${API_ROOT}/user/repos`,
    headers: { ...baseHeaders, "Content-Type": "application/json" },
    authRef: auth,
    body: JSON.stringify({
      name: opts.name,
      description: opts.description,
      private: opts.private ?? true,
      auto_init: opts.autoInit ?? false,
    }),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`GitHub /user/repos create failed (status ${res.status}): ${res.body}`);
  }
  return toRepo(JSON.parse(res.body) as RepoDto);
}

function toRepo(dto: RepoDto): GitHubRepo {
  return {
    name: dto.name,
    fullName: dto.full_name,
    description: dto.description,
    private: dto.private,
    defaultBranch: dto.default_branch,
    cloneUrl: dto.clone_url,
    sshUrl: dto.ssh_url,
  };
}
