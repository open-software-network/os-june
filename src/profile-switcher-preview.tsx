// Dev-only preview entry: renders the real SidebarIdentity (account menu +
// profile switcher) against the faked Tauri bridge in
// profile-switcher-preview.html, with __profileSwitcherDemo() pre-armed, so
// the switcher can be designed and screenshotted in a plain browser (no
// native build, no Hermes runtime). Nothing here ships: vite builds only the
// configured entries.
import { useState } from "react";
import ReactDOM from "react-dom/client";
import { SidebarIdentity } from "./components/sidebar/Sidebar";
import { registerProfileSwitcherDemo } from "./lib/profile-switcher-demo";
import type { AccountStatus } from "./lib/tauri";
import { initTheme } from "./lib/theme";
import "./styles/app.css";

initTheme();
registerProfileSwitcherDemo();
(
  window as unknown as { __profileSwitcherDemo: (input?: boolean | string[]) => string }
).__profileSwitcherDemo();

const account: AccountStatus = {
  signedIn: true,
  configured: true,
  user: {
    id: "usr_preview",
    handle: "andrew",
    displayName: "Andrew",
    email: "andrew@example.com",
  },
};

function Preview() {
  const [menuOpen, setMenuOpen] = useState(true);
  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <aside
        className="sidebar"
        style={{ display: "flex", flexDirection: "column", width: 260, height: "100%" }}
      >
        <div style={{ flex: 1 }} />
        <footer className="sidebar-footer">
          <SidebarIdentity
            account={account}
            menuOpen={menuOpen}
            onToggleMenu={() => setMenuOpen((open) => !open)}
            onCloseMenu={() => setMenuOpen(false)}
            onInviteFriends={() => console.log("[preview] invite friends")}
            onOpenSettings={() => console.log("[preview] open settings")}
            onManageProfiles={() => console.log("[preview] manage profiles")}
            onReportIssue={(category) => console.log("[preview] report", category)}
            onSignOut={() => console.log("[preview] sign out")}
          />
        </footer>
      </aside>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Preview />);
