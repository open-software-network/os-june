import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SudoPart, SecretPart } from "../components/agent/AgentWorkspace";
import type { AgentChatPart } from "../lib/agent-chat-runtime";
import { createHermesMethods } from "../lib/hermes-control-plane";
import secretFixture from "../lib/hermes-control-plane/fixtures/secret-request-response.json";

const SECRET_VALUE = secretFixture._secretValuePlaceholder;

function sudoPart(
  overrides: Partial<Extract<AgentChatPart, { type: "sudo" }>> = {},
): Extract<AgentChatPart, { type: "sudo" }> {
  return {
    type: "sudo",
    id: "su-1",
    sessionId: "sess-sudo",
    command: "apt-get install ripgrep",
    reason: "ripgrep is required to search the dependency tree",
    mode: "unrestricted",
    status: "pending",
    ...overrides,
  };
}

function secretPart(
  overrides: Partial<Extract<AgentChatPart, { type: "secret" }>> = {},
): Extract<AgentChatPart, { type: "secret" }> {
  return {
    type: "secret",
    id: "se-1",
    sessionId: "sess-secret",
    keyName: "OPENAI_API_KEY",
    reason: "Needed to call the OpenAI API on your behalf",
    status: "pending",
    ...overrides,
  };
}

describe("SudoPart card", () => {
  it("blocks the session with an explicit approve/deny card showing the command and mode", () => {
    render(<SudoPart part={sudoPart()} onSudo={() => {}} />);

    expect(screen.getByText("apt-get install ripgrep")).toBeInTheDocument();
    expect(
      screen.getByText(/ripgrep is required to search the dependency tree/),
    ).toBeInTheDocument();
    // The execution mode is shown explicitly so the user knows the blast radius.
    expect(screen.getByText(/unrestricted/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /approve/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /deny/i })).toBeInTheDocument();
  });

  it("invokes respondToSudo with approved=true and the mode when approved", async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    const methods = createHermesMethods(request);
    const onSudo = vi.fn((part: Extract<AgentChatPart, { type: "sudo" }>) =>
      methods.respondToSudo({
        sessionId: part.sessionId ?? "",
        requestId: part.id,
        approved: true,
        mode: part.mode,
      }),
    );

    render(<SudoPart part={sudoPart()} onSudo={onSudo} />);
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    expect(onSudo).toHaveBeenCalledWith(
      expect.objectContaining({ id: "su-1" }),
      true,
    );
    expect(request).toHaveBeenCalledWith("sudo.respond", {
      session_id: "sess-sudo",
      request_id: "su-1",
      approved: true,
      mode: "unrestricted",
    });
  });

  it("invokes respondToSudo with approved=false when denied", async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    const methods = createHermesMethods(request);
    const onSudo = vi.fn((part: Extract<AgentChatPart, { type: "sudo" }>) =>
      methods.respondToSudo({
        sessionId: part.sessionId ?? "",
        requestId: part.id,
        approved: false,
      }),
    );

    render(<SudoPart part={sudoPart()} onSudo={onSudo} />);
    await userEvent.click(screen.getByRole("button", { name: /deny/i }));

    expect(onSudo).toHaveBeenCalledWith(
      expect.objectContaining({ id: "su-1" }),
      false,
    );
    expect(request).toHaveBeenCalledWith("sudo.respond", {
      session_id: "sess-sudo",
      request_id: "su-1",
      approved: false,
    });
  });

  it("degrades to an actionable card when command and reason are absent", () => {
    render(
      <SudoPart
        part={sudoPart({
          command: undefined,
          reason: undefined,
          mode: undefined,
        })}
        onSudo={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: /approve/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /deny/i })).toBeInTheDocument();
  });
});

describe("SecretPart card", () => {
  it("blocks the session with a secure input and explains where the secret is used", () => {
    render(<SecretPart part={secretPart()} onSecret={() => {}} />);

    // The reason explains where the secret is used.
    expect(
      screen.getByText(/Needed to call the OpenAI API on your behalf/),
    ).toBeInTheDocument();
    // OPENAI_API_KEY matches the sensitive-key pattern, so the label is masked
    // rather than shown verbatim (see the dedicated redaction test).
    expect(screen.queryByText("OPENAI_API_KEY")).not.toBeInTheDocument();
    const input = screen.getByLabelText(/secret value/i) as HTMLInputElement;
    // A secure input never echoes the typed value to the screen.
    expect(input.type).toBe("password");
  });

  it("submits the typed value through respondToSecret then clears it from local state", async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    const methods = createHermesMethods(request);
    const onSecret = vi.fn(
      (part: Extract<AgentChatPart, { type: "secret" }>, value: string) =>
        methods.respondToSecret({
          sessionId: part.sessionId ?? "",
          requestId: part.id,
          value,
        }),
    );

    render(<SecretPart part={secretPart()} onSecret={onSecret} />);
    const input = screen.getByLabelText(/secret value/i) as HTMLInputElement;
    await userEvent.type(input, SECRET_VALUE);
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(onSecret).toHaveBeenCalledWith(
      expect.objectContaining({ id: "se-1" }),
      SECRET_VALUE,
    );
    expect(request).toHaveBeenCalledWith("secret.respond", {
      session_id: "sess-secret",
      request_id: "se-1",
      value: SECRET_VALUE,
    });

    // SECURITY: the input is cleared immediately after submit so the value
    // does not linger in the DOM/local state.
    await waitFor(() => {
      expect(
        (screen.getByLabelText(/secret value/i) as HTMLInputElement).value,
      ).toBe("");
    });
  });

  it("SECURITY: never shows the typed value and wipes it from the DOM on submit", async () => {
    const onSecret = vi.fn();
    render(<SecretPart part={secretPart()} onSecret={onSecret} />);
    const input = screen.getByLabelText(/secret value/i) as HTMLInputElement;
    await userEvent.type(input, SECRET_VALUE);

    // While typing the value lives only on the masked password input — never in
    // any VISIBLE rendered text.
    expect(document.body.textContent ?? "").not.toContain(SECRET_VALUE);

    // After submit the value is handed off once and then wiped from local state,
    // so it no longer exists anywhere in the DOM (value property or serialized
    // attribute).
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));
    await waitFor(() => {
      const cleared = screen.getByLabelText(
        /secret value/i,
      ) as HTMLInputElement;
      expect(cleared.value).toBe("");
    });
    expect(document.body.innerHTML).not.toContain(SECRET_VALUE);
    expect(document.body.textContent ?? "").not.toContain(SECRET_VALUE);
    // The value reached the handler exactly once, by value, and is not retained.
    expect(onSecret).toHaveBeenCalledTimes(1);
    expect(onSecret).toHaveBeenCalledWith(expect.anything(), SECRET_VALUE);
  });

  it("supports cancel without submitting any value", async () => {
    const onSecret = vi.fn();
    const onCancel = vi.fn();
    render(
      <SecretPart
        part={secretPart()}
        onSecret={onSecret}
        onCancel={onCancel}
      />,
    );
    const input = screen.getByLabelText(/secret value/i) as HTMLInputElement;
    await userEvent.type(input, SECRET_VALUE);
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(onSecret).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "se-1" }),
    );
    // Cancel also wipes the entered value.
    await waitFor(() => {
      expect(
        (screen.getByLabelText(/secret value/i) as HTMLInputElement).value,
      ).toBe("");
    });
  });

  it("redacts a secret-like key name in the label", () => {
    // A key like "DATABASE_PASSWORD" must be masked, never shown verbatim.
    render(
      <SecretPart
        part={secretPart({ keyName: "DATABASE_PASSWORD" })}
        onSecret={() => {}}
      />,
    );
    expect(screen.queryByText("DATABASE_PASSWORD")).not.toBeInTheDocument();
    expect(screen.getByText(/\[redacted\]/i)).toBeInTheDocument();
  });
});
