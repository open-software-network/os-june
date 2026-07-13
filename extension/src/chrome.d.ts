// Minimal ambient declarations for the chrome.* APIs this extension uses.
// @types/chrome could not be installed when this package was created (the
// sfw install wrapper needs an interactive session); swap this file for the
// real package the next time dependencies are touched (JUN-287 follow-up).
// Keep it scoped to what the code calls so the compiler still catches typos.

declare namespace chrome {
  namespace runtime {
    interface Port {
      postMessage(message: unknown): void;
      disconnect(): void;
      onMessage: {
        addListener(callback: (message: unknown) => void): void;
      };
      onDisconnect: {
        addListener(callback: () => void): void;
      };
    }

    function connectNative(application: string): Port;
    function getManifest(): { version: string };
    function sendMessage(message: unknown): Promise<unknown>;

    const onInstalled: {
      addListener(callback: () => void): void;
    };
    const onStartup: {
      addListener(callback: () => void): void;
    };
    const onMessage: {
      addListener(
        callback: (
          message: { type?: string } | undefined,
          sender: unknown,
          sendResponse: (response?: unknown) => void,
        ) => void,
      ): void;
    };
  }

  namespace action {
    function setBadgeText(details: { text: string }): Promise<void>;
    function setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  }
}
