# June copy guidelines

The source of truth for how to talk about June in marketing, product UI, support, and docs. Written for agents and humans who have not read the codebase. Every claim here is backed by a file in this repo or the marketing repo; if you change the architecture, search this doc for the file you touched.

If a claim you want to make is not covered here, derive it from section 2 (how the data flows) and err toward the narrower version. June's brand is precision: an accurate modest claim always beats an impressive vague one.

## 1. What June is

June is a private AI assistant for the desktop, made by OpenSoftware. It does three things: dictation (hold a key, speak, and clean text lands at your cursor in any app), meeting notes (records and transcribes meetings, then writes structured notes), and an agent (hands off real desktop tasks, built on the open source Hermes framework). It ships on macOS 14+ today; the product is a desktop assistant, not a Mac app, so say "desktop" unless you are stating system requirements or describing a platform-specific feature. Requires an OpenSoftware account (OS Accounts) and a subscription with a free trial.

June's differentiator is that its privacy claims are architectural and verifiable rather than promised: the agent runs locally, model calls route through zero-retention models by default, and the backend runs in a confidential VM (TEE) whose code is open source and cryptographically attested. (Positioning source: `content/site-copy.ts` on the `codex/june-landing-privacy-copy` branch of os-marketing-page.)

## 2. How the data actually flows

Writers extrapolate, so here is the model to extrapolate from.

**Stays on your device:** the agent runtime (a local Hermes process), its files, sessions, memory, and state (`src-tauri/src/hermes_bridge.rs`); recordings, transcripts, and notes (local app database); dictation history (local, with a retention window).

**Leaves your device, only for model inference:** audio (for transcription) and prompts plus context (for note generation, dictation cleanup, and the agent's thinking). Nothing else is mirrored anywhere.

**The path:** app → Scribe API (the backend, running in an Intel TDX confidential VM, the "TEE") → the model. Generation and most transcription route through Venice. The opt-in OpenAI transcription models (`gpt-4o-mini-transcribe`, `gpt-4o-transcribe`) go from the TEE directly to OpenAI; for those, Scribe API itself is the anonymization layer: requests are structurally anonymous (the request type cannot carry file names, titles, or identifying metadata) and the server proxy hides your IP. The attestation chain (README.md, and the `/verify` page served from inside the TEE) proves the backend runs the exact open source code we publish. It verifies the code in the VM, not what upstream model providers do. (Sources: `scribe-api/crates/providers/src/routing.rs`, `src-tauri/src/providers/mod.rs` `transcription_provider_for_model`, PR #223, `README.md:19`.)

**Three model privacy tiers** (source: `src/lib/model-privacy.ts`, the only approved definitions):

- **E2EE:** the prompt is encrypted on your device and only decrypted inside a hardware-secured enclave; no prompt data is ever readable by the model provider or its infrastructure.
- **Private (the default):** zero data retention. No prompt data is stored, shared with a third party, or trained on.
- **Anonymous (opt-in):** identity is stripped before the request reaches the model provider, but the provider may retain what it receives under its own policy. For anonymized models in the Venice catalog, Venice does the routing and anonymizing; for the opt-in OpenAI transcription models, our backend does (no identifying metadata, IP hidden by the server proxy).

**What the company stores:** account, login, and billing records, via OS Accounts. **What it never stores:** prompts, transcripts, files, memory. (Source: `privacy.promises` in `site-copy.ts`; onboarding "June doesn't collect your data" step.)

**The agent's two risk surfaces, never to be conflated:** inference privacy is June's property and is always on. Action risk is governed by the user: the agent asks before it edits, deletes, sends, or spends, and when the user approves an outward action (sending an email, visiting a site), the other side sees what it shares. June keeps your data private; it cannot make the rest of the internet private. (Source: the onboarding honesty step, `src/components/onboarding/steps/LearnSteps.tsx`.)

## 3. Claims ledger

The DON'T column is banned in all copy, even casually, even in tweets. The WHY explains the gap so you can recognize new variants.

| DON'T say | WHY it's wrong | SAY instead | Source |
|---|---|---|---|
| "100% local", "everything runs on your Mac", "nothing ever leaves your device" | Inference leaves the device by design: audio and prompts go out for every model call | "June runs locally. Prompts and audio leave your device only for model inference, through private routing." | `README.md:19` |
| "June runs privately on your Mac" | Conflates the local runtime (true) with private inference (separate claim, model-dependent) | "June runs locally. All model calls are private." (default tier) or "...are anonymized." (anonymous tier) | `src/lib/model-privacy.ts` |
| "We can't see your data", unqualified | True for content, false for identity: OS Accounts holds account, login, and billing records | "We store only your account, login, and billing records. Your prompts, transcripts, files, and memory are not on that list." | `site-copy.ts` privacy.promises |
| "Your data is never stored or trained on", unqualified | True on the default Private tier; Anonymous-tier providers may retain prompts | Add "by default" or name the tier: "By default, June uses zero-retention models: nothing stored, no training." | `model-privacy.ts` ANONYMOUS_MODEL_DESCRIPTION |
| "End-to-end encrypted" as a blanket product claim | Only the E2EE model tier is E2EE. The TEE is a different mechanism (confidential compute on our backend), and most usage is the Private tier | Name the tier: "E2EE models encrypt your prompt all the way into a hardware enclave." | `model-privacy.ts` E2EE_MODEL_DESCRIPTION |
| "The TEE means your data is private everywhere" | The attestation chain verifies the code running in the confidential VM, not what upstream providers do with what they receive | "You can verify the exact code our backend runs. What leaves it goes to zero-retention models by default." | `README.md:19` |
| "Everything goes through Venice", "all models are Venice models" | The opt-in OpenAI transcription models route from our backend directly to OpenAI; Venice is not in that path. Our backend is the anonymization layer there | "Model calls are anonymized before they leave our backend. Most route through Venice; the opt-in OpenAI transcription models go to OpenAI carrying no identifying metadata, with your IP hidden by our server proxy." | `routing.rs`, `providers/mod.rs`, PR #223 |
| "Anonymized models are fully private" | Anonymization strips identity; the provider still sees the prompt and may retain it | "Anonymous models: your identity is stripped, but the provider still sees your prompt and may retain it." | `model-privacy.ts` |
| "Your meetings never leave your Mac" | Meeting audio leaves for transcription (that is how notes get made); transcripts and notes are stored locally | "Transcripts and notes stay on your device. Audio goes out only for transcription, through private routing." | `README.md:19`, CONTEXT.md (note transcription) |
| "The agent is safe", "June won't make mistakes" | The product's own onboarding says the opposite, on purpose. Honesty about fallibility is brand canon | "The agent can make mistakes. Nothing irreversible happens without you: it asks before it edits, deletes, sends, or spends." | `LearnSteps.tsx` honesty step |
| "Everything the agent does is private" | Conflates inference privacy with agent actions. An approved outward action is visible to its recipient | "June keeps your data private; when the agent acts on your behalf, the other side sees what you approved it to share." | `LearnSteps.tsx` honesty step |
| "No account needed", "we don't know who you are" | Sign-in through OS Accounts is required; identity and billing exist by design | Lead with what the account does NOT include: "Your account is your login and billing. Your content is not attached to it on our servers." | `CONTEXT.md` (OS Accounts) |
| "Trust us" framings in privacy copy | The entire positioning is the opposite: verification over trust | "Verify rather than trust": point to the open source code, the attestation, the `/verify` page | `site-copy.ts` hero eyebrow |

Pattern to internalize: most violations come from dropping a qualifier ("by default", "for model inference", "on the Private tier") because the sentence sounds punchier without it. The qualifier is the claim. Keep it.

## 4. Approved language bank

Verbatim-safe lines. Use them as written or as calibration for new copy.

- **"Private by architecture, not by promise."** The positioning headline. Use for hero copy and section eyebrows.
- **"The private AI assistant for your desktop."** The product one-liner.
- **"Nothing changes until you say yes."** The agent approval model in one line. Use anywhere the agent's autonomy needs reassurance.
- **"June runs locally. All model calls are private."** Status-line pattern; swap the second sentence to "All model calls are anonymized." when the selected model is Anonymous tier.
- **"We store only what it takes to run the service: account, login, and billing records. Your prompts, transcripts, and memory are not on that list."** The retention claim, fully qualified.
- **"Everything leaving the TEE for model inference is anonymized. By default it runs on Venice private models: zero data retention, no training."** The canonical routing summary (long form in `README.md:19`). When detail is needed: "requests carry no identifying metadata and our server proxy hides your IP".
- **The three model-tier descriptions in `src/lib/model-privacy.ts`.** Quote them exactly; do not paraphrase tier guarantees.
- **The honesty-step triad** ("The agent can make mistakes." / "Nothing irreversible happens without you." / "Private inference protects your data; it doesn't approve the agent's actions."). The template for all agent-risk copy.
- **"Verify it yourself."** The CTA for attestation and open source claims.

## 5. Terminology

Binding definitions from `CONTEXT.md`; its "avoid" lists apply to all copy.

- **June** is the product name (formerly OS Scribe). Code, binaries, and bundle IDs still say Scribe; never surface "Scribe" in user-facing copy. Avoid: notetaker, OS Notetaker.
- **Scribe API** is the backend in the TEE. Avoid: backend, proxy, AI proxy.
- **OS Accounts** is the identity and credits platform. Avoid: the auth service, the identity service.
- **Upstream provider** is a third-party AI service reached through Scribe API. Avoid: vendor, model provider (in technical docs; "model provider" is acceptable in consumer copy about the Anonymous tier).
- **Dictation** (push-to-talk, instant) vs **note transcription** (recorded session, batch) vs **note generation** (transcript to structured note). Never say just "transcription"; say which. Avoid: speech-to-text.
- **Credits** are OS Accounts credits ($1 = 1000 credits). Never use "credits" for upstream provider cost.
- **Desktop, not Mac.** June is a desktop product that currently ships on macOS. Say "desktop" (or "your device" / "your computer") in product and category copy; name macOS only for system requirements ("macOS 14+") or platform-specific behavior (System Settings permissions, the menu bar). Don't write copy that becomes false the day another platform ships.

## 6. Voice and mechanics

- **Sentence case for everything**: titles, buttons, headings, eyebrows, pills. Never ALL CAPS. (`CLAUDE.md`)
- **No em-dashes or en-dashes in any user-facing copy.** Rewrite with a period, comma, colon, or parentheses. Ranges use a plain hyphen ("5-10 min"). (`CLAUDE.md`)
- **Calm, precise, plain.** Short declaratives ("That's the list."). Specifics over adjectives: "zero data retention" beats "ultra-secure". No fear-mongering, no hype, no exclamation marks in product UI.
- **Honest about limits, on purpose.** Stating what June does not cover (agent mistakes, anonymous-tier retention, what attestation does not prove) is part of the brand, not a concession. Never delete a caveat to make a sentence prettier.
- **Define before you abbreviate.** First mention: "a confidential VM (TEE)", "end-to-end encrypted (E2EE)".

## 7. Needs decision (conflicts found while writing this)

1. **"Free to try · macOS 14+"** (landing `finale.support`) vs the shipped subscription gate: membership is mandatory and the trial requires a card up front. "Free to try" without qualification may overpromise; suggest "Free trial · macOS 14+".
2. **`ANONYMOUS_MODEL_DESCRIPTION` in `model-privacy.ts` contains an em-dash**, violating the no-dash rule from `CLAUDE.md`; the #180 sweep missed it.
3. **Landing copy "agent runs locally in June's intended configuration"**: the hedge ("intended configuration") reads as legalese on a marketing page; either explain it or drop it.
