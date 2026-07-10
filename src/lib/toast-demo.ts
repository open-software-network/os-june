// Dev-only console driver for the toast suite (components/ui/Toaster.tsx):
//
//   window.__toastDemo()          fire one of every variant, staggered
//   window.__toastDemo("success") fire just the success toast
//   window.__toastDemo("error")   ...error / "destructive"
//   window.__toastDemo("info")    ...info / default
//   window.__toastDemo("warning") ...warning (caution)
//   window.__toastDemo("loading") ...a loading toast that resolves after 2s
//   window.__toastDemo("action")  ...a toast with an action button
//   window.__toastDemo("clear")   dismiss everything on screen
//
// It only calls the real `toast` helper, so Andrew can jam on the toast styling
// (in the app or the browser sandbox) without walking a real model switch or
// any other flow. Mirrors the other dev drivers (processing-progress-demo.ts,
// global-recorder-demo.ts). Never bundled in production: App gates the dynamic
// import on import.meta.env.DEV.

import { toast } from "../components/ui/Toaster";

export type ToastDemoApi = {
  /** Remove the window hook. */
  dispose: () => void;
};

type ToastDemoVariant =
  | "default"
  | "info"
  | "success"
  | "error"
  | "warning"
  | "loading"
  | "action"
  | "all"
  | "clear";

function fireVariant(variant: Exclude<ToastDemoVariant, "all" | "clear">): void {
  switch (variant) {
    case "default":
      toast("Draft saved to this note.");
      return;
    case "info":
      toast.info("Default model updated. It applies to new sessions.");
      return;
    case "success":
      toast.success("Switched this session to Kimi K2.6.");
      return;
    case "error":
      toast.error(
        "Could not switch the running session. This chat will use the new model next time.",
      );
      return;
    case "warning":
      toast.warning(
        "This endpoint is not on this machine. Requests will leave your device. Select the local model again to confirm.",
      );
      return;
    case "loading": {
      const id = toast.loading("Connecting to the local endpoint...");
      window.setTimeout(() => {
        toast.success("Connected to the local endpoint.", { id });
      }, 2000);
      return;
    }
    case "action":
      toast("June found a newer note for this meeting.", {
        action: {
          label: "Open note",
          onClick: () => toast.success("Opened the newer note."),
        },
      });
      return;
  }
}

/** Registers window.__toastDemo. Dev-only; call dispose() to remove the hook. */
export function registerToastDemo(): ToastDemoApi {
  const run = (variant: ToastDemoVariant = "all") => {
    if (variant === "clear") {
      toast.dismiss();
      return;
    }
    if (variant !== "all") {
      fireVariant(variant);
      return;
    }
    // Stagger the full suite so each toast stacks in rather than landing at
    // once, which is how a real burst of notifications would arrive.
    const order = ["default", "info", "success", "warning", "error", "loading", "action"] as const;
    order.forEach((variant, index) => {
      window.setTimeout(() => fireVariant(variant), index * 350);
    });
  };

  (window as unknown as { __toastDemo?: typeof run }).__toastDemo = run;

  return {
    dispose() {
      (window as unknown as { __toastDemo?: typeof run }).__toastDemo = undefined;
    },
  };
}
