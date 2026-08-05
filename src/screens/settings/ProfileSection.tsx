/**
 * Settings -> Profile: who the user is on this machine. Everything here is
 * local — the fields feed git commit signatures and new-project authorship,
 * and the picture is a file Rust copied into app data.
 */

import { User } from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { Show, createMemo, createSignal } from "solid-js";

import { TextField } from "~/components/forms/TextField";
import { Button } from "~/components/primitives/Button";
import * as ipc from "~/ipc";
import { describeIpcError } from "~/lib/errors";
import { fileUrlFromPath } from "~/lib/file-url";
import { notifyError } from "~/lib/toast";
import {
  type ProfileFields,
  noteProfileAvatar,
  profile,
  profileAvatarPath,
  setProfile,
} from "~/stores/settings-store";

const Card: Component<{
  title: string;
  subtitle?: string;
  children: JSX.Element;
}> = (props) => (
  <div class="glass overflow-hidden rounded-xl">
    <div class="flex items-start justify-between border-b border-glass-stroke px-5 py-4">
      <div>
        <div class="text-base font-semibold tracking-tight text-fg-1">
          {props.title}
        </div>
        <Show when={props.subtitle}>
          <div class="mt-0.5 text-sm leading-relaxed text-fg-2">
            {props.subtitle}
          </div>
        </Show>
      </div>
    </div>
    <div>{props.children}</div>
  </div>
);

const Row: Component<{
  label: string;
  hint?: string;
  children: JSX.Element;
}> = (props) => (
  <div class="flex items-center gap-4 border-t border-glass-stroke px-5 py-3.5 first:border-t-0">
    <div class="min-w-0 flex-1">
      <div class="text-base font-medium text-fg-1">{props.label}</div>
      <Show when={props.hint}>
        <div class="mt-0.5 text-xs leading-relaxed text-fg-3">{props.hint}</div>
      </Show>
    </div>
    <div class="flex-shrink-0">{props.children}</div>
  </div>
);

/** Up to two letters from the display name, falling back to the email's local
 *  part. Empty when neither has one, which swaps in the placeholder icon. */
function initialsFor(name: string, email: string): string {
  const source = name.trim() || email.trim().split("@")[0] || "";
  return source
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => Array.from(word)[0].toUpperCase())
    .join("");
}

const PICTURE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];

export const ProfileSection: Component = () => {
  const [busy, setBusy] = createSignal(false);
  // The stored file keeps one name per format, so replacing a picture with the
  // same extension leaves the URL identical and the webview would keep serving
  // the previous bytes out of cache. Seeded from the clock rather than 0: a
  // per-session counter replays the same URLs every launch (`avatar.png?v=1`
  // for the second PNG ever picked), and the asset handler sends no
  // Cache-Control, so heuristic freshness could still serve the old image.
  const [pictureVersion, setPictureVersion] = createSignal(Date.now());

  const pictureSrc = createMemo(() => {
    const path = profileAvatarPath();
    return path ? `${fileUrlFromPath(path)}?v=${pictureVersion()}` : null;
  });

  const initials = () => initialsFor(profile().displayName, profile().email);

  const update = (patch: Partial<ProfileFields>) => {
    setProfile({ ...profile(), ...patch });
  };

  const changePicture = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      filters: [{ name: "Image", extensions: PICTURE_EXTENSIONS }],
      title: "Choose a profile picture",
    });
    if (typeof picked !== "string" || picked.length === 0) return;
    setBusy(true);
    try {
      noteProfileAvatar(await ipc.setProfileAvatar(picked));
      setPictureVersion((v) => v + 1);
    } catch (e) {
      notifyError("Couldn't set the picture", describeIpcError(e));
    } finally {
      setBusy(false);
    }
  };

  const removePicture = async () => {
    setBusy(true);
    try {
      await ipc.clearProfileAvatar();
      noteProfileAvatar(null);
    } catch (e) {
      notifyError("Couldn't remove the picture", describeIpcError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="space-y-3">
      <Card
        title="Profile"
        subtitle="Stored on this machine. Nothing here is sent anywhere."
      >
        <Row
          label="Picture"
          hint="PNG, JPEG, WebP, or GIF up to 8 MB. The image is copied into Typeward's data folder, so moving the original doesn't break it."
        >
          <div class="flex items-center gap-2">
            <div
              class="flex h-12 w-12 flex-shrink-0 items-center justify-center overflow-hidden rounded-full border border-glass-stroke bg-[var(--color-control-fill)]"
              aria-hidden="true"
            >
              <Show
                when={pictureSrc()}
                fallback={
                  <Show
                    when={initials()}
                    fallback={<User class="ui-icon-menu text-fg-3" />}
                  >
                    <span class="text-sm font-semibold text-fg-2">
                      {initials()}
                    </span>
                  </Show>
                }
              >
                <img
                  src={pictureSrc()!}
                  alt=""
                  class="h-full w-full object-cover"
                />
              </Show>
            </div>
            <Button
              variant="secondary"
              size="sm"
              class="h-8"
              disabled={busy()}
              onClick={() => void changePicture()}
            >
              Change picture
            </Button>
            <Show when={profileAvatarPath()}>
              <Button
                variant="ghost"
                size="sm"
                class="h-8"
                disabled={busy()}
                onClick={() => void removePicture()}
              >
                Remove
              </Button>
            </Show>
          </div>
        </Row>

        <div class="flex flex-col gap-3 border-t border-glass-stroke px-5 py-3.5">
          <div class="flex gap-2">
            <div class="min-w-0 flex-1">
              <TextField
                label="Display name"
                size="sm"
                type="text"
                value={profile().displayName}
                onInput={(e) => update({ displayName: e.currentTarget.value })}
              />
            </div>
            <div class="min-w-0 flex-1">
              <TextField
                label="Email"
                size="sm"
                type="email"
                placeholder="e.g. you@example.com"
                value={profile().email}
                onInput={(e) => update({ email: e.currentTarget.value })}
              />
            </div>
          </div>
          <TextField
            label="Affiliation"
            size="sm"
            type="text"
            placeholder="e.g. Department of Physics"
            value={profile().affiliation}
            onInput={(e) => update({ affiliation: e.currentTarget.value })}
          />
          <p class="text-xs leading-relaxed text-fg-3">
            The name and email sign your git commits and pre-fill the author of
            new projects.
          </p>
        </div>
      </Card>
    </div>
  );
};
