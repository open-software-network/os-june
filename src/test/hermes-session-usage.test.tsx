import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { parseSessionUsage, type SessionUsage } from "../lib/hermes-session-usage";
import type { VeniceModelDto } from "../lib/tauri";
import { SessionUsagePanel } from "../components/agent/SessionUsagePanel";
import { USAGE_DEMO_FIXTURES, USAGE_DEMO_ORDER } from "../lib/usage-panel-demo";

const formatCount = (value: number) => value.toLocaleString();
const numberPattern = (value: number) => new RegExp(formatCount(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const tokensPattern = (value: number) =>
  new RegExp(`${formatCount(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} tokens`);

// A full usage payload as the gateway might return it. Mixes snake_case and a
// nested tool-cost breakdown so the parser is exercised on realistic wire data.
const FULL_RAW = {
  session_id: "sess-1",
  provider: "anthropic",
  model: "claude-opus-4",
  usage: {
    prompt_tokens: 1200,
    completion_tokens: 800,
    total_tokens: 2000,
  },
  context: { used: 18000, limit: 200000 },
  estimated_cost_usd: 0.4213,
  tool_costs: [
    { name: "web_search", estimated_cost_usd: 0.01 },
    { name: "code_subagent", estimated_cost_usd: 0.12 },
  ],
};

describe("parseSessionUsage", () => {
  it("normalizes a full snake_case payload", () => {
    const usage = parseSessionUsage("sess-1", FULL_RAW);
    expect(usage.sessionId).toBe("sess-1");
    expect(usage.provider).toBe("anthropic");
    expect(usage.model).toBe("claude-opus-4");
    expect(usage.promptTokens).toBe(1200);
    expect(usage.completionTokens).toBe(800);
    expect(usage.totalTokens).toBe(2000);
    expect(usage.contextUsed).toBe(18000);
    expect(usage.contextLimit).toBe(200000);
    expect(usage.estimatedCostUsd).toBeCloseTo(0.4213);
    expect(usage.toolCosts).toEqual([
      { name: "web_search", estimatedCostUsd: 0.01 },
      { name: "code_subagent", estimatedCostUsd: 0.12 },
    ]);
    expect(usage.raw).toBe(FULL_RAW);
  });

  it("tolerates camelCase keys", () => {
    const usage = parseSessionUsage("sess-2", {
      provider: "openai",
      model: "gpt-x",
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      contextUsed: 5,
      contextLimit: 100,
      estimatedCostUsd: 1.5,
    });
    expect(usage.promptTokens).toBe(10);
    expect(usage.completionTokens).toBe(20);
    expect(usage.totalTokens).toBe(30);
    expect(usage.contextUsed).toBe(5);
    expect(usage.contextLimit).toBe(100);
    expect(usage.estimatedCostUsd).toBe(1.5);
  });

  it("leaves missing fields undefined on a partial payload", () => {
    const usage = parseSessionUsage("sess-3", { usage: { prompt_tokens: 5 } });
    expect(usage.sessionId).toBe("sess-3");
    expect(usage.promptTokens).toBe(5);
    expect(usage.completionTokens).toBeUndefined();
    expect(usage.totalTokens).toBeUndefined();
    expect(usage.contextUsed).toBeUndefined();
    expect(usage.contextLimit).toBeUndefined();
    expect(usage.estimatedCostUsd).toBeUndefined();
    expect(usage.model).toBeUndefined();
    expect(usage.provider).toBeUndefined();
  });

  it("never throws on junk input and keeps numeric fields undefined", () => {
    for (const junk of [null, undefined, 42, "nope", [], { usage: "weird" }]) {
      const usage = parseSessionUsage("sess-x", junk);
      expect(usage.sessionId).toBe("sess-x");
      expect(usage.promptTokens).toBeUndefined();
      expect(usage.totalTokens).toBeUndefined();
    }
  });

  it("ignores non-finite / non-numeric numeric fields", () => {
    const usage = parseSessionUsage("sess-4", {
      usage: { prompt_tokens: "1200", total_tokens: Number.NaN },
      estimated_cost_usd: "free",
    });
    expect(usage.promptTokens).toBeUndefined();
    expect(usage.totalTokens).toBeUndefined();
    expect(usage.estimatedCostUsd).toBeUndefined();
  });

  it("reads Hermes's flat SessionUsageResponse field names", () => {
    // The live gateway returns input/output/total, context_used/context_max,
    // and cost_usd at the root (no nested usage/context) and omits provider.
    // Regression guard: these aliases must map, or the panel shows "Unavailable".
    const usage = parseSessionUsage("sess-hermes", {
      model: "zai-org-glm-5-2",
      input: 1200,
      output: 800,
      total: 2000,
      context_used: 118000,
      context_max: 128000,
      context_percent: 92,
      cost_usd: 0.21,
      cost_status: "estimated",
    });
    expect(usage.model).toBe("zai-org-glm-5-2");
    expect(usage.promptTokens).toBe(1200);
    expect(usage.completionTokens).toBe(800);
    expect(usage.totalTokens).toBe(2000);
    expect(usage.contextUsed).toBe(118000);
    expect(usage.contextLimit).toBe(128000);
    expect(usage.estimatedCostUsd).toBeCloseTo(0.21);
    expect(usage.provider).toBeUndefined();
  });
});

function fetchUsageFor(raw: unknown) {
  return vi.fn(
    async (sessionId: string): Promise<SessionUsage> => parseSessionUsage(sessionId, raw),
  );
}

describe("SessionUsagePanel", () => {
  it("renders all metrics from a full payload", async () => {
    const fetchUsage = fetchUsageFor(FULL_RAW);
    const { container } = render(
      <SessionUsagePanel sessionId="sess-1" fetchUsage={fetchUsage} onClose={() => {}} />,
    );

    // Resolves once on mount.
    await waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(1));
    expect(fetchUsage).toHaveBeenCalledWith("sess-1");

    // No resolver: the raw model id shows, with the provider muted inline after
    // it in the same model row (no right-aligned cell).
    const modelName = await screen.findByText("claude-opus-4");
    expect(modelName).toBeInTheDocument();
    const provider = screen.getByText("anthropic");
    expect(provider).toBeInTheDocument();
    expect(provider.closest(".agent-usage-model-row")).not.toBeNull();

    // The model row renders BEFORE the context meter in DOM order.
    const meter = container.querySelector(".agent-usage-meter");
    expect(meter).not.toBeNull();
    expect(
      // biome-ignore lint/style/noNonNullAssertion: asserted not-null above.
      modelName.compareDocumentPosition(meter!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Context reading and percent surface from the meter (always visible).
    expect(screen.getByText(numberPattern(18000))).toBeInTheDocument();
    expect(screen.getByText(tokensPattern(200000))).toBeInTheDocument();
    expect(screen.getByText(/^9%$/)).toBeInTheDocument();

    // Token rows and cost live behind the "Show more" disclosure: collapsed by
    // default (aria-expanded=false, region not open).
    const toggle = screen.getByRole("button", { name: "Show more" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const disclosure = container.querySelector(".agent-usage-disclosure");
    expect(disclosure).not.toBeNull();
    expect(disclosure).not.toHaveAttribute("data-open");
    const disclosureInner = container.querySelector(".agent-usage-disclosure-inner");
    expect(disclosureInner).toHaveAttribute("aria-hidden", "true");

    // Expand: the token rows, tool costs, and estimated cost appear.
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(disclosure).toHaveAttribute("data-open", "true");
    expect(disclosureInner).toHaveAttribute("aria-hidden", "false");
    expect(screen.getByText(numberPattern(1200))).toBeInTheDocument();
    expect(screen.getByText(/^800$/)).toBeInTheDocument();
    expect(screen.getByText(numberPattern(2000))).toBeInTheDocument();
    expect(screen.getByText(/\$0\.42/)).toBeInTheDocument();
    expect(screen.getByText("web_search")).toBeInTheDocument();
    expect(screen.getByText("code_subagent")).toBeInTheDocument();

    // Collapse again: aria-expanded / data-open flip back (the grid trick keeps
    // the nodes mounted, so we assert via disclosure state, not removal).
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.getByRole("button", { name: "Show more" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(disclosure).not.toHaveAttribute("data-open");
    expect(disclosureInner).toHaveAttribute("aria-hidden", "true");
  });

  it('renders the "Usage" title heading', async () => {
    const fetchUsage = fetchUsageFor(FULL_RAW);
    render(<SessionUsagePanel sessionId="sess-1" fetchUsage={fetchUsage} onClose={() => {}} />);
    // The restored header anchor is present as a real heading.
    expect(screen.getByRole("heading", { name: "Usage" })).toBeInTheDocument();
    // And it stays put once data lands.
    await screen.findByText("claude-opus-4");
    expect(screen.getByRole("heading", { name: "Usage" })).toBeInTheDocument();
  });

  it("renders a structure-matched skeleton on first load, then lights the same track", async () => {
    let resolve!: (value: SessionUsage) => void;
    const fetchUsage = vi.fn(
      () =>
        new Promise<SessionUsage>((r) => {
          resolve = r;
        }),
    );
    const { container } = render(
      <SessionUsagePanel sessionId="sess-1" fetchUsage={fetchUsage} onClose={() => {}} />,
    );
    // First load: the body is busy and renders the REAL structure with
    // placeholders — shimmer bars for the model name and the two legend
    // readings, plus the real 60-segment meter track sitting empty (0 lit).
    const body = container.querySelector(".agent-usage-body");
    expect(body).not.toBeNull();
    expect(body).toHaveAttribute("aria-busy", "true");
    // data-first-load exempts the busy first-load body from the refresh dim so
    // the quiet skeleton bars stay at full strength.
    expect(body).toHaveAttribute("data-first-load");
    expect(container.querySelectorAll(".agent-usage-skeleton")).toHaveLength(3);
    expect(container.querySelectorAll(".agent-usage-meter-segment")).toHaveLength(60);
    expect(container.querySelectorAll('.agent-usage-meter-segment[data-lit="true"]')).toHaveLength(
      0,
    );
    // No content, no toggle, no disclosure while pending.
    expect(screen.queryByText("opus")).toBeNull();
    expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();

    // Content lands: the shimmer bars are gone, the model name and the same
    // meter track (still 60 segments) light up, and the toggle appears.
    resolve(
      parseSessionUsage("sess-1", {
        model: "opus",
        context_used: 100000,
        context_max: 200000,
        total: 2000,
      }),
    );
    expect(await screen.findByText("opus")).toBeInTheDocument();
    expect(container.querySelector(".agent-usage-skeleton")).toBeNull();
    expect(container.querySelectorAll(".agent-usage-meter-segment")).toHaveLength(60);
    await waitFor(() =>
      expect(
        container.querySelectorAll('.agent-usage-meter-segment[data-lit="true"]').length,
      ).toBeGreaterThan(0),
    );
    expect(screen.getByRole("button", { name: "Show more" })).toBeInTheDocument();
  });

  it("frames cost as an estimate with fine print when the disclosure is open", async () => {
    const fetchUsage = fetchUsageFor(FULL_RAW);
    render(<SessionUsagePanel sessionId="sess-1" fetchUsage={fetchUsage} onClose={() => {}} />);
    // Open the disclosure that holds the cost.
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    // The dollar value is present...
    expect(screen.getByText(/\$0\.42/)).toBeInTheDocument();
    // ...labeled as an estimate, with the disclaimer fine print.
    expect(screen.getByText("Estimated cost")).toBeInTheDocument();
    expect(
      screen.getByText("Estimate based on reported token usage. Actual billing may differ."),
    ).toBeInTheDocument();
  });

  it("omits the cost row and fine print when estimatedCostUsd is undefined", async () => {
    const fetchUsage = fetchUsageFor({
      model: "opus",
      usage: { total_tokens: 2000 },
    });
    render(<SessionUsagePanel sessionId="sess-1" fetchUsage={fetchUsage} onClose={() => {}} />);
    await waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("opus")).toBeInTheDocument();
    // The total-tokens row lives behind the disclosure; open it.
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByText(numberPattern(2000))).toBeInTheDocument();
    // No cost row and no disclaimer when there is no cost, even when expanded.
    expect(screen.queryByText("Estimated cost")).toBeNull();
    expect(screen.queryByText(/Actual billing may differ/)).toBeNull();
  });

  it("omits rows for missing fields instead of rendering Unavailable", async () => {
    const fetchUsage = fetchUsageFor({ model: "opus", usage: { prompt_tokens: 5 } });
    render(<SessionUsagePanel sessionId="sess-3" fetchUsage={fetchUsage} onClose={() => {}} />);
    await waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("opus")).toBeInTheDocument();
    // Input tokens live behind the disclosure; open it.
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByText(/^5$/)).toBeInTheDocument();
    // Absent provider and output rows are simply not rendered.
    expect(screen.queryByText("Provider")).toBeNull();
    expect(screen.queryByText("Output")).toBeNull();
    expect(screen.queryByText("anthropic")).toBeNull();
    // The "Unavailable" pattern is gone entirely.
    expect(screen.queryByText("Unavailable")).toBeNull();
  });

  it("shows the empty state for a payload with nothing usable", async () => {
    const fetchUsage = fetchUsageFor({ unrelated: "junk" });
    render(<SessionUsagePanel sessionId="sess-empty" fetchUsage={fetchUsage} onClose={() => {}} />);
    await waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("No usage reported for this session yet.")).toBeInTheDocument();
  });

  it("refresh calls session.usage exactly once per click", async () => {
    const fetchUsage = fetchUsageFor(FULL_RAW);
    render(<SessionUsagePanel sessionId="sess-1" fetchUsage={fetchUsage} onClose={() => {}} />);
    // One fetch on mount.
    await waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(2));
    // Exactly one more call — the click does not fan out.
    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });

  it("renders the resolved display name and its privacy badge", async () => {
    const fetchUsage = fetchUsageFor({ provider: "anthropic", model: "opus" });
    // A minimal DTO whose privacy field yields a "private" badge (label
    // "Private mode") per modelPrivacyFlags/modelPrivacyBadge.
    const privateModel: VeniceModelDto = {
      provider: "venice",
      id: "opus",
      name: "Claude Opus 4",
      modelType: "text",
      privacy: "private",
      traits: [],
      capabilities: [],
    };
    render(
      <SessionUsagePanel
        sessionId="sess-1"
        fetchUsage={fetchUsage}
        onClose={() => {}}
        resolveModel={(id) => (id === "opus" ? privateModel : undefined)}
      />,
    );
    // Display name from the DTO...
    expect(await screen.findByText("Claude Opus 4")).toBeInTheDocument();
    // ...and the privacy chip renders inline in the model row, replacing the raw
    // provider (which is no longer shown once the DTO resolves).
    const badge = screen.getByText("Private mode");
    expect(badge).toBeInTheDocument();
    expect(badge.closest(".agent-usage-model-row")).not.toBeNull();
    expect(screen.queryByText("anthropic")).toBeNull();
    // The chip is the themed, small pill: brand-tinted `.agent-safety-badge` with
    // the `-sm` modifier, not the muted trait-icon chip.
    const chip = badge.closest(".agent-safety-badge");
    expect(chip).not.toBeNull();
    expect(chip).toHaveClass("agent-safety-badge-sm");
    expect(badge.closest(".model-trait-icon")).toBeNull();
  });

  it("falls back to the raw model id and provider when resolveModel returns undefined", async () => {
    const fetchUsage = fetchUsageFor({ provider: "anthropic", model: "opus" });
    render(
      <SessionUsagePanel
        sessionId="sess-1"
        fetchUsage={fetchUsage}
        onClose={() => {}}
        resolveModel={() => undefined}
      />,
    );
    expect(await screen.findByText("opus")).toBeInTheDocument();
    expect(screen.getByText("anthropic")).toBeInTheDocument();
  });

  it("clamps the meter limit to the model's real context window", async () => {
    // The runtime reports context_max of 1,000,000 (its own budget), but the
    // resolved model is a 200K-window model. The meter must read against 200,000.
    const fetchUsage = fetchUsageFor({
      model: "glm-5-2",
      context_used: 100000,
      context_max: 1000000,
    });
    const glm: VeniceModelDto = {
      provider: "venice",
      id: "glm-5-2",
      name: "GLM 5.2",
      modelType: "text",
      traits: [],
      capabilities: [],
      contextTokens: 200000,
    };
    render(
      <SessionUsagePanel
        sessionId="sess-1"
        fetchUsage={fetchUsage}
        onClose={() => {}}
        resolveModel={(id) => (id === "glm-5-2" ? glm : undefined)}
      />,
    );
    await waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(1));
    // Reading and percent computed against 200,000, not 1,000,000.
    expect(await screen.findByText(tokensPattern(200000))).toBeInTheDocument();
    expect(screen.getByText(/^50%$/)).toBeInTheDocument();
    // The runtime's 1,000,000 does not surface as the denominator.
    expect(screen.queryByText(tokensPattern(1000000))).toBeNull();
  });

  it("renders 60 meter segments and lights the count matching the percent", async () => {
    // 100,000 / 200,000 = 50% -> round(0.5 * 60) = 30 lit segments.
    const fetchUsage = fetchUsageFor({
      model: "opus",
      context_used: 100000,
      context_max: 200000,
    });
    const { container } = render(
      <SessionUsagePanel sessionId="sess-1" fetchUsage={fetchUsage} onClose={() => {}} />,
    );
    await waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(1));
    // Exactly 60 segments render regardless of percent.
    await waitFor(() =>
      expect(container.querySelectorAll(".agent-usage-meter-segment")).toHaveLength(60),
    );
    // The rAF-driven light-up settles on 30 lit segments.
    await waitFor(() =>
      expect(
        container.querySelectorAll('.agent-usage-meter-segment[data-lit="true"]'),
      ).toHaveLength(30),
    );
  });

  it("staggers the lit segments with an eased wavefront settling near SWEEP_MS", async () => {
    // 50% -> 30 lit segments. The per-segment transitionDelay must increase
    // across the lit segments (an eased wavefront) and the last lit segment must
    // land near the ~550ms sweep constant.
    const fetchUsage = fetchUsageFor({
      model: "opus",
      context_used: 100000,
      context_max: 200000,
    });
    const { container } = render(
      <SessionUsagePanel sessionId="sess-1" fetchUsage={fetchUsage} onClose={() => {}} />,
    );
    await waitFor(() =>
      expect(
        container.querySelectorAll('.agent-usage-meter-segment[data-lit="true"]'),
      ).toHaveLength(30),
    );
    const litDelays = Array.from(
      container.querySelectorAll<HTMLElement>('.agent-usage-meter-segment[data-lit="true"]'),
    ).map((seg) => Number.parseFloat(seg.style.transitionDelay));

    // First lit dot starts at 0ms.
    expect(litDelays[0]).toBeCloseTo(0, 5);
    // Delays are strictly monotonically increasing across the lit dots.
    for (let i = 1; i < litDelays.length; i++) {
      expect(litDelays[i]).toBeGreaterThan(litDelays[i - 1]);
    }
    // The last lit dot's delay lands right at the ~550ms sweep (eased, so the
    // final step is the softest). Allow a few ms of float slack.
    expect(litDelays[litDelays.length - 1]).toBeCloseTo(550, 0);
  });

  it("lights exactly one segment for a tiny nonzero usage", async () => {
    // 1 / 200,000 = 0.0005% -> would round to 0, but a nonzero usage floors to 1.
    const fetchUsage = fetchUsageFor({
      model: "opus",
      context_used: 1,
      context_max: 200000,
    });
    const { container } = render(
      <SessionUsagePanel sessionId="sess-1" fetchUsage={fetchUsage} onClose={() => {}} />,
    );
    await waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        container.querySelectorAll('.agent-usage-meter-segment[data-lit="true"]'),
      ).toHaveLength(1),
    );
    const [lit] = Array.from(
      container.querySelectorAll<HTMLElement>('.agent-usage-meter-segment[data-lit="true"]'),
    );
    expect(lit.style.transitionDelay).toBe("0ms");
  });

  it("lights no segments for zero usage", async () => {
    const fetchUsage = fetchUsageFor({
      model: "opus",
      context_used: 0,
      context_max: 200000,
    });
    const { container } = render(
      <SessionUsagePanel sessionId="sess-1" fetchUsage={fetchUsage} onClose={() => {}} />,
    );
    await waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(1));
    // All 60 segments render...
    await waitFor(() =>
      expect(container.querySelectorAll(".agent-usage-meter-segment")).toHaveLength(60),
    );
    // ...but none are lit.
    expect(container.querySelectorAll('.agent-usage-meter-segment[data-lit="true"]')).toHaveLength(
      0,
    );
  });

  it("rests every segment at identical bounds (lit and unlit share box, no inline scale)", async () => {
    // 50% -> some lit, some unlit. Lit ticks must sit within the same bounds as
    // the gray ticks beneath: same class list (differing only by data-lit) and
    // no inline transform/scale on any segment. The sweep is color-only.
    const fetchUsage = fetchUsageFor({
      model: "opus",
      context_used: 100000,
      context_max: 200000,
    });
    const { container } = render(
      <SessionUsagePanel sessionId="sess-1" fetchUsage={fetchUsage} onClose={() => {}} />,
    );
    await waitFor(() =>
      expect(
        container.querySelectorAll('.agent-usage-meter-segment[data-lit="true"]'),
      ).toHaveLength(30),
    );
    const segments = Array.from(
      container.querySelectorAll<HTMLElement>(".agent-usage-meter-segment"),
    );
    for (const seg of segments) {
      // Every segment carries exactly the one box class; lit state is expressed
      // by the data-lit attribute, not a distinct sizing class.
      expect(seg.className).toBe("agent-usage-meter-segment");
      // No inline transform/scale: the resting size is identical for lit/unlit.
      expect(seg.style.transform).toBe("");
    }
  });

  it("flips the meter to the critical level at 90% and higher (no warn tier)", async () => {
    // 184,000 / 200,000 = 92%, past the 90% critical threshold.
    const fetchUsage = fetchUsageFor({
      model: "opus",
      context_used: 184000,
      context_max: 200000,
    });
    const { container } = render(
      <SessionUsagePanel sessionId="sess-1" fetchUsage={fetchUsage} onClose={() => {}} />,
    );
    const track = await screen.findByRole("progressbar", { name: "Context used" });
    expect(track).toHaveAttribute("data-level", "critical");
    // The retired warn tier never appears.
    expect(container.querySelector('[data-level="warn"]')).toBeNull();
  });

  it("keeps the meter at the normal level below the 90% threshold", async () => {
    // 170,000 / 200,000 = 85%: under critical, and there is no warn tier, so
    // this is plain "normal".
    const fetchUsage = fetchUsageFor({
      model: "opus",
      context_used: 170000,
      context_max: 200000,
    });
    render(<SessionUsagePanel sessionId="sess-1" fetchUsage={fetchUsage} onClose={() => {}} />);
    const track = await screen.findByRole("progressbar", { name: "Context used" });
    expect(track).toHaveAttribute("data-level", "normal");
  });

  it("exposes the progressbar ARIA on the dot track", async () => {
    const fetchUsage = fetchUsageFor({
      model: "opus",
      context_used: 100000,
      context_max: 200000,
    });
    render(<SessionUsagePanel sessionId="sess-1" fetchUsage={fetchUsage} onClose={() => {}} />);
    const bar = await screen.findByRole("progressbar", { name: "Context used" });
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-valuenow", "50");
  });

  it("renders no Show more toggle when there are no detail rows", async () => {
    // Context + model, but no token counts and no cost: nothing to disclose.
    const fetchUsage = fetchUsageFor({
      model: "opus",
      context_used: 5000,
      context_max: 100000,
    });
    render(<SessionUsagePanel sessionId="sess-1" fetchUsage={fetchUsage} onClose={() => {}} />);
    expect(await screen.findByText("opus")).toBeInTheDocument();
    // The meter still renders...
    expect(screen.getByText(/^5%$/)).toBeInTheDocument();
    // ...but there is nothing behind a disclosure, so no toggle.
    expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
  });
});

describe("usage panel demo fixtures", () => {
  it("every fixture is a valid SessionUsage shape with a resolvable model", () => {
    for (const key of USAGE_DEMO_ORDER) {
      const fixture = USAGE_DEMO_FIXTURES[key];
      // Round-trips through the parser without throwing (a valid usable shape).
      const reparsed = parseSessionUsage(fixture.usage.sessionId, fixture.usage);
      expect(reparsed.sessionId).toBe(fixture.usage.sessionId);
      // The demo model resolves for the fixture's model id (except "empty",
      // which carries no model on the usage payload).
      if (fixture.usage.model !== undefined) {
        expect(fixture.usage.model).toBe(fixture.model.id);
      }
    }
  });

  it('renders "half" through the panel with the model row and meter (no empty state)', async () => {
    const fixture = USAGE_DEMO_FIXTURES.half;
    const fetchUsage = vi.fn(async () => fixture.usage);
    render(
      <SessionUsagePanel
        sessionId={fixture.usage.sessionId}
        fetchUsage={fetchUsage}
        onClose={() => {}}
        resolveModel={(id) => (id === fixture.model.id ? fixture.model : undefined)}
      />,
    );
    // Model display name (from the DTO) and its "private" badge light up.
    expect(await screen.findByText("GLM 5.2")).toBeInTheDocument();
    expect(screen.getByText("Private mode")).toBeInTheDocument();
    // The meter reads about half of the 200K window; not the empty state.
    expect(screen.getByText(/^50%$/)).toBeInTheDocument();
    expect(screen.queryByText("No usage reported for this session yet.")).toBeNull();
  });

  it('renders "cost" through the panel with the estimated cost and tool rows', async () => {
    const fixture = USAGE_DEMO_FIXTURES.cost;
    const fetchUsage = vi.fn(async () => fixture.usage);
    render(
      <SessionUsagePanel
        sessionId={fixture.usage.sessionId}
        fetchUsage={fetchUsage}
        onClose={() => {}}
        resolveModel={(id) => (id === fixture.model.id ? fixture.model : undefined)}
      />,
    );
    // Open the disclosure that holds the cost + tool breakdown.
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    expect(screen.getByText("Estimated cost")).toBeInTheDocument();
    expect(screen.getByText("web_search")).toBeInTheDocument();
    expect(screen.getByText("code_subagent")).toBeInTheDocument();
    expect(screen.queryByText("No usage reported for this session yet.")).toBeNull();
  });
});
