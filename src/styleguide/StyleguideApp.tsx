import { useCallback, useEffect, useState } from "react";
import {
  applyBrandVar,
  type BrandId,
  BRAND_PRESETS,
  getStoredBrand,
  setStoredBrand,
} from "../lib/brand";
import { applyTheme, getStoredTheme, setStoredTheme, type ThemePreference } from "../lib/theme";
import { SECTION_GROUPS, SECTIONS, type SectionGroup } from "./sections";

const THEME_OPTIONS: { id: ThemePreference; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

function sectionFromUrl(): string {
  const param = new URLSearchParams(location.search).get("section");
  if (param && SECTIONS.some((s) => s.id === param)) return param;
  return SECTIONS[0]?.id ?? "";
}

export function StyleguideApp() {
  const [activeId, setActiveId] = useState<string>(sectionFromUrl);
  const [theme, setTheme] = useState<ThemePreference>(getStoredTheme);
  const [brand, setBrand] = useState<BrandId>(getStoredBrand);

  // Bumped on every theme/brand change so sections re-read live token values.
  const [themeVersion, setThemeVersion] = useState(0);
  const bump = useCallback(() => setThemeVersion((v) => v + 1), []);

  // When the theme is "system", follow the OS preference change too.
  useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => bump();
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [theme, bump]);

  const selectSection = useCallback((id: string) => {
    setActiveId(id);
    const url = new URL(location.href);
    url.searchParams.set("section", id);
    history.replaceState(null, "", url);
  }, []);

  const pickTheme = useCallback(
    (id: ThemePreference) => {
      setTheme(id);
      setStoredTheme(id);
      applyTheme(id);
      bump();
    },
    [bump],
  );

  const pickBrand = useCallback(
    (id: BrandId) => {
      setBrand(id);
      setStoredBrand(id);
      applyBrandVar(id, { animate: true });
      // Re-resolve after the brand transition settles.
      window.setTimeout(bump, 260);
    },
    [bump],
  );

  const active = SECTIONS.find((s) => s.id === activeId) ?? SECTIONS[0];
  const ActiveComponent = active?.component;

  return (
    <div className="sg-root">
      <header className="sg-topbar">
        <h1 className="sg-topbar-title">June styleguide</h1>
        <div className="sg-topbar-controls">
          <fieldset className="sg-control-group">
            <legend className="sg-control-label">Theme</legend>
            <div className="sg-seg">
              {THEME_OPTIONS.map((option) => (
                <button
                  type="button"
                  key={option.id}
                  className="sg-seg-btn"
                  aria-pressed={theme === option.id}
                  onClick={() => pickTheme(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="sg-control-group">
            <legend className="sg-control-label">Brand</legend>
            <div className="sg-brand-swatches">
              {BRAND_PRESETS.map((preset) => (
                <button
                  type="button"
                  key={preset.id}
                  className="sg-brand-swatch"
                  style={{ background: preset.value }}
                  aria-pressed={brand === preset.id}
                  aria-label={preset.label}
                  title={preset.label}
                  onClick={() => pickBrand(preset.id)}
                />
              ))}
            </div>
          </fieldset>
        </div>
      </header>

      <nav className="sg-nav" aria-label="Sections">
        {SECTION_GROUPS.map((group: SectionGroup) => {
          const items = SECTIONS.filter((s) => s.group === group);
          return (
            <div className="sg-nav-group" key={group}>
              <div className="sg-nav-group-label">{group}</div>
              {items.length === 0 ? (
                <div className="sg-nav-item-placeholder">Coming soon</div>
              ) : (
                items.map((section) => (
                  <button
                    type="button"
                    key={section.id}
                    className="sg-nav-item"
                    aria-current={section.id === activeId}
                    onClick={() => selectSection(section.id)}
                  >
                    {section.label}
                  </button>
                ))
              )}
            </div>
          );
        })}
      </nav>

      <main className="sg-content">
        {/* themeVersion in the key forces a re-render so resolveToken re-reads
            the live computed values after a theme/brand switch. */}
        {ActiveComponent ? <ActiveComponent key={`${active.id}:${themeVersion}`} /> : null}
      </main>
    </div>
  );
}
