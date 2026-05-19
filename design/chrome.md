# Chrome — Top bars, icons, route memory

## Traffic lights

The three colored dots in the top-left of both `TopBar` (Projects/Settings
shell) and `EditorTopBar` are **removed**. Tauri ships a real window decoration
and we don't need to fake it.

## Top-right icon sizing

Density-aware icon size token, used by every "chrome icon" (settings,
notifications, layout, history, share):

```css
--ui-icon-chrome: 20px;       /* cozy default */
[data-density="compact"]     { --ui-icon-chrome: 18px; }
[data-density="comfortable"] { --ui-icon-chrome: 24px; }
```

Existing icons measure 16px or smaller. The new defaults align to OS norms
(macOS 16-20px, Windows 20-24px).

## Keyboard hint chips

Used in: New project button, Recompile button, Save indicator, menu items.

Platform-specific rendering, computed once at app boot from `navigator.platform`
or `tauri-plugin-os`:

| Platform | Modifier | Display |
|---|---|---|
| macOS | Cmd | `⌘` |
| Windows | Ctrl | `Ctrl` |
| Linux | Ctrl | `Ctrl` |
| Tablet | (none) | Chip hidden |

Implementation: a `<KbdHint>` component that takes a shortcut token like
`Mod+N` and renders the OS-appropriate chip with proper centering of the
modifier glyph inside its background rectangle.

The current bug — where the first kbd icon isn't centered inside its gray
rectangle — is a CSS issue (line-height / font-baseline mismatch on the `⌘`
glyph). Fixing it in the new `<KbdHint>` primitive instead of patching the
existing one-off styles.

## Route memory

When the user enters Settings from the Editor:

```ts
// src/stores/nav-store.ts
export const [previousRoute, setPreviousRoute] = createSignal<string | null>(null);
```

`SettingsScreen`'s back button reads `previousRoute()` and navigates there;
defaults to `/projects` when empty (covers fresh boot, deep-linked settings).

This replaces the current behavior where Settings → back always goes to
Projects.
