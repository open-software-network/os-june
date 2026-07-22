import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { ComposerModelPicker } from "./components/agent/composer/ModelPicker";
import {
  type ModelPickerFlyout,
  ModelPickerPopover,
} from "./components/settings/ModelPickerPopover";
import type { VeniceModelDto } from "./lib/tauri";
import type { ThinkingLevel } from "./lib/thinking-level";
import "./styles/app.css";

const autoModel: VeniceModelDto = {
  provider: "open-software",
  id: "open-software/auto",
  name: "Auto",
  modelType: "text",
  traits: [],
  capabilities: ["supportsFunctionCalling"],
};

const generationModels: VeniceModelDto[] = [
  autoModel,
  {
    provider: "venice",
    id: "zai-org-glm-5-2",
    name: "GLM 5.2",
    modelType: "text",
    privacy: "private",
    traits: [],
    capabilities: ["supportsFunctionCalling"],
  },
  {
    provider: "venice",
    id: "kimi-k2-6",
    name: "Kimi K2.6",
    modelType: "text",
    privacy: "private",
    traits: [],
    capabilities: ["supportsFunctionCalling", "supportsVision"],
  },
];

function Preview() {
  const [open, setOpen] = useState(false);
  const [flyout, setFlyout] = useState<ModelPickerFlyout>(null);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("hard");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  return (
    <main
      style={{
        display: "grid",
        minHeight: "100vh",
        placeItems: "center",
        padding: "48px",
        background: "var(--background)",
      }}
    >
      <section style={{ width: "480px" }}>
        <div className="agent-composer-box">
          <div style={{ minHeight: "72px", padding: "12px" }}>Ask June anything</div>
          <div className="agent-composer-toolbar">
            <span style={{ color: "var(--muted-foreground)", paddingInline: "8px" }}>+</span>
            <div className="agent-composer-actions">
              <ComposerModelPicker
                open={open}
                model={autoModel}
                detail="Quality"
                effort={thinkingLevel}
                triggerRef={triggerRef}
                onToggleOpen={() => {
                  setFlyout(null);
                  setOpen((current) => !current);
                }}
              />
            </div>
          </div>
        </div>
        {open ? (
          <ModelPickerPopover
            mode="generation"
            flyout={flyout}
            model={autoModel}
            options={generationModels}
            costQuality={100}
            search=""
            popoverRef={popoverRef}
            searchRef={searchRef}
            onFlyoutChange={setFlyout}
            onSearchChange={() => undefined}
            onSelect={() => undefined}
            onCostQualityChange={() => undefined}
            thinkingLevel={thinkingLevel}
            onSelectThinking={(level) => {
              setThinkingLevel(level);
              setFlyout(null);
            }}
          />
        ) : null}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
