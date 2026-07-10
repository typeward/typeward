import type { Component } from "solid-js";
import { For, Show } from "solid-js";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
} from "~/components/primitives/ContextMenu";
import { describeIpcError } from "~/lib/errors";
import { notifyError } from "~/lib/toast";
import { registerBaseEditorMenuActions } from "./base-actions";
import { editorMenuGroups, type EditorMenuContext } from "./registry";

registerBaseEditorMenuActions();

/**
 * The editor surface's right-click menu, rendered from the action registry:
 * one `ContextMenuItem` per visible action, separators between groups. The
 * component mounts fresh per open (text-shell keys it on the menu state), so
 * snapshotting the groups once here is deliberate — actions registered while
 * the menu is open appear on the next open.
 */
export const EditorContextMenu: Component<{
  x: number;
  y: number;
  ctx: EditorMenuContext;
  onClose: () => void;
}> = (props) => {
  const groups = editorMenuGroups(props.ctx);
  return (
    <ContextMenu x={props.x} y={props.y} onClose={props.onClose} widthPx={220}>
      <For each={groups}>
        {(group, gi) => (
          <>
            <Show when={gi() > 0}>
              <ContextMenuSeparator />
            </Show>
            <For each={group}>
              {(action) => (
                <ContextMenuItem
                  icon={action.icon}
                  label={action.label}
                  disabled={action.enabled ? !action.enabled(props.ctx) : false}
                  onClick={() => {
                    props.onClose();
                    void Promise.resolve(action.run(props.ctx)).catch((e) =>
                      notifyError(
                        `Couldn't run "${action.label}"`,
                        describeIpcError(e),
                      ),
                    );
                  }}
                />
              )}
            </For>
          </>
        )}
      </For>
    </ContextMenu>
  );
};
