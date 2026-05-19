import { Dialog as KDialog } from "@kobalte/core/dialog";
import { X } from "lucide-solid";
import type { Component, JSX } from "solid-js";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: JSX.Element;
  /** Optional footer (e.g. confirm/cancel buttons). */
  footer?: JSX.Element;
  /** Tailwind width utility, e.g. "w-[480px]". */
  widthClass?: string;
}

export const Dialog: Component<DialogProps> = (props) => {
  return (
    <KDialog open={props.open} onOpenChange={props.onOpenChange}>
      <KDialog.Portal>
        <KDialog.Overlay class="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm data-[expanded]:animate-in data-[expanded]:fade-in" />
        <div class="fixed inset-0 z-50 flex items-center justify-center p-6">
          <KDialog.Content
            class={`glass rounded-xl ${props.widthClass ?? "w-[480px]"} max-h-[90vh] overflow-hidden flex flex-col`}
          >
            <div class="flex items-start justify-between gap-3 border-b border-glass-stroke px-5 py-3.5">
              <div class="flex flex-col gap-0.5">
                <KDialog.Title class="text-[14px] font-semibold tracking-tight text-fg-1">
                  {props.title}
                </KDialog.Title>
                {props.description ? (
                  <KDialog.Description class="text-[12px] text-fg-3">
                    {props.description}
                  </KDialog.Description>
                ) : null}
              </div>
              <KDialog.CloseButton class="lift -m-1 rounded-md p-1 text-fg-3 hover:bg-[var(--color-control-fill)] hover:text-fg-1">
                <X size={14} />
              </KDialog.CloseButton>
            </div>
            <div class="flex-1 overflow-auto scroll px-5 py-4">
              {props.children}
            </div>
            {props.footer ? (
              <div class="flex items-center justify-end gap-2 border-t border-glass-stroke px-5 py-3">
                {props.footer}
              </div>
            ) : null}
          </KDialog.Content>
        </div>
      </KDialog.Portal>
    </KDialog>
  );
};
