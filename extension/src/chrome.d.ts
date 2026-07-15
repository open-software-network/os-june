// Minimal ambient declarations for the chrome.* APIs this extension uses.
// @types/chrome could not be installed when this package was created (the
// sfw install wrapper needs an interactive session); swap this file for the
// real package the next time dependencies are touched (JUN-287 follow-up).
// Keep it scoped to what the code calls so the compiler still catches typos.

interface ChromeDebuggerApi {
  attach(target: { tabId?: number }, requiredVersion: string): Promise<void>;
  detach(target: { tabId?: number }): Promise<void>;
  sendCommand(
    target: { tabId?: number },
    method: string,
    commandParams?: Record<string, unknown>,
  ): Promise<unknown>;
  onEvent: {
    addListener(
      callback: (
        source: { tabId?: number },
        method: string,
        params?: Record<string, unknown>,
      ) => void,
    ): void;
  };
  onDetach: {
    addListener(callback: (source: { tabId?: number }, reason: string) => void): void;
  };
}

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
          message: { type?: string; tabId?: number } | undefined,
          sender: unknown,
          sendResponse: (response?: unknown) => void,
        ) => boolean | undefined,
      ): void;
    };
  }

  namespace action {
    function setBadgeText(details: { text: string }): Promise<void>;
    function setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  }

  namespace tabs {
    interface Tab {
      id?: number;
      title?: string;
      url?: string;
      groupId?: number;
    }
    function create(details: { url: string; active?: boolean }): Promise<Tab>;
    function get(tabId: number): Promise<Tab>;
    function update(tabId: number, details: { active?: boolean }): Promise<Tab>;
    function query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
    function remove(tabIds: number | number[]): Promise<void>;
    function group(details: { tabIds: number[]; groupId?: number }): Promise<number>;
    function ungroup(tabIds: number[]): Promise<void>;
    const onRemoved: { addListener(callback: (tabId: number) => void): void };
    const onUpdated: {
      addListener(
        callback: (tabId: number, changeInfo: { groupId?: number }, tab: Tab) => void,
      ): void;
    };
  }

  namespace tabGroups {
    interface TabGroup {
      id: number;
      title?: string;
    }
    function get(groupId: number): Promise<TabGroup>;
    function update(groupId: number, details: { title: string }): Promise<void>;
    const onUpdated: { addListener(callback: (group: TabGroup) => void): void };
  }
}
