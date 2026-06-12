# June Onboarding — Design Doc

**Date:** 2026-06-09
**Inputs:** Wispr Flow onboarding (25-screen capture), June landing privacy copy (`codex/june-landing-privacy-copy` branch of `os-marketing-page`)

---

## 1. What makes Wispr's onboarding world-class (and what we keep)

From the screen capture, Wispr's flow is: **SIGN UP → PERMISSIONS → SET UP → LEARN → PERSONALIZE**, with a persistent stage progress bar. The principles worth stealing:

1. **One ask per screen.** Every screen has exactly one question, one button, or one action.
2. **Show the scary part before asking for it.** Each permission screen pairs the request (left) with a live screencast of the exact macOS dialog/System Settings toggle (right). Users never wonder "what will this look like / where do I click."
3. **Justify every permission in one sentence of plain language.** "Flow will only access the mic when you are actively using it." "This lets Flow put your spoken words in the right textbox."
4. **Close the trust loop.** After permissions: "Thanks for trusting us, we value your privacy" with green checkmarks recapping what was granted.
5. **Verify hardware before teaching.** Mic test ("Do you see purple bars?") and hotkey test ("Does the button turn purple?") are yes/no questions with live visual feedback — failure is caught before the first practice rep, so the magic moment can't whiff.
6. **Learn by doing in simulated apps.** Three practice reps inside fake Slack/Gmail/Notion, escalating in skill: free dictation → scripted self-correction ("Friday at 3, no actually 4" — teaches that fillers and corrections get cleaned up) → whisper mode. Each rep ends with "Good work!"
7. **Immediate, personal reward.** "You just spoke 2.1x faster than the average typist" with the user's real number, then a time-saved projection with an interactive slider.
8. **Personalization should serve the user directly.** Ask only for inputs that immediately improve the onboarding path or product experience.
9. **Viral loop at the exit.** "2 people from your company are using Flow" → create team.
10. **Onboarding doesn't end at the last screen.** First app launch opens a "How would you like to use Flow first?" modal that routes to a first real task.

## 2. June's problem is harder than Wispr's

Wispr teaches **one** behavior (hold fn, talk). June must teach **three** — dictation, meeting notes, agent — plus a privacy story and an honest risk disclosure. Naively copying Wispr's depth for all three features produces a 45-screen onboarding nobody finishes.

### Approaches considered

- **A — Dictation-first spine, staged depth (recommended).** Full Wispr-style hands-on treatment for dictation only (it's the only feature that can deliver a live magic moment in the first 3 minutes — meetings need a meeting, agents need a task worth delegating). Meeting notes and agent get *show-don't-tell* demos plus the risk/privacy education in onboarding, with heavy permissions and first-runs deferred to just-in-time moments. ~20 screens, ≤7 minutes.
- **B — Three full tracks.** Hands-on practice for all three features up front. Highest comprehension, but 12+ minutes and meeting notes/agent practice would be fake-feeling (no real meeting, no real task). Drop-off risk too high.
- **C — Dictation-only onboarding.** Fastest, but fails the explicit requirements: users must learn meeting notes, the agent, the privacy model, and the agent's risks during onboarding.

**Recommendation: A.** It preserves Wispr's pacing (magic moment by minute 3) while meeting every education requirement. The agent risk disclosure stays *inside* onboarding (it's a stated requirement), but the agent's file-access permission and first task happen just-in-time, where consent is informed by context.

### Permissions strategy ("same permissions" + June's extras)

| Permission | When asked | Why there |
|---|---|---|
| Microphone | Onboarding (Stage 3) | Core to dictation; same as Wispr. "June only listens while you hold the hotkey or while a meeting note is recording." |
| Accessibility | Onboarding (Stage 3) | Core to dictation; same as Wispr. "Lets June type your words into whatever app you're using." |
| Screen & System Audio Recording (for meeting audio) | Just-in-time, first meeting note | Scariest macOS permission; asking during onboarding with no meeting in sight tanks trust and grant-rates. Onboarding *previews* that this ask is coming. |
| File access for the agent | Just-in-time, first agent task | The agent asks per-scope when given its first task; the onboarding risk screen previews this. Aligns with "nothing changes until you say yes." |

Onboarding's permission recap screen explicitly sets the expectation: *"Two more permissions will come later, when they make sense: macOS will ask for system audio the first time you record a meeting, and the agent will ask before it touches your files."*

## 3. The flow

Progress bar: **SIGN UP → PRIVACY → PERMISSIONS → SET UP → LEARN → PERSONALIZE**

Layout language is Wispr's: split-screen (task left, illustration/demo right) for signup/permissions; centered card on watermark background for tests and practice; full dark screen for reward moments.

### Stage 1 — Sign up (4 screens)

**1. Welcome.** Logo + "Let's get you started." Sub: "The private AI assistant for your desktop." `Sign in via browser`. Right panel: auto-rotating carousel — dictation typing into a real app ("Works in any app"), meeting notes assembling themselves, the agent finishing a task ("Your work stays on your Mac").

**2. Welcome, {name}!** "What should June help with first?" chips.

**3. Tell us about yourself.** "What do you do for work?" — role chips (feeds later examples: a lawyer sees a contract-summary agent task, a founder sees an investor-update draft).

**4. What should June take off your plate?** Multi-select chips: `Writing by voice` · `Meeting notes` · `Research & drafts` · `Digging through files` · `Recurring busywork`. Copy: "Select all that apply — we'll tailor your setup." This seeds the Learn-stage order and the first agent task suggestions.

### Stage 2 — Privacy (2 screens) — *the June twist*

Wispr buries data-sharing as one screen. Privacy is June's reason to exist, so it gets a named stage — but only two screens, because trust is earned by behavior (the just-in-time asks, the approval gates), not by paragraphs.

**5. "Private by architecture, not by promise."** Three cards (copy adapted from the landing branch):
- **Local by default** — "The agent runs on your Mac. Files, sessions, memory, and state stay on your disk — never mirrored to a cloud."
- **Private inference** — "When June needs a model, your prompt goes out through private routing to zero-retention models by default. Nothing stored. No training on your data. Ever."
- **Verifiable** — "Our code is open source and our backend runs in a secure enclave (TEE). You don't have to trust us — you can check." Link: `Verify it yourself ↗`

Right panel: a simple animated diagram — your Mac (files/memory/agent inside a solid border) with one thin arrow out labeled "prompt → zero-retention model" and nothing coming back but the answer.

**6. Choose your data sharing preference.** Single toggle, **default OFF** (Wispr makes you choose; June's brand demands the private default): "Share anonymized usage analytics to help improve June." Below: "Either way: we store only your account, login, and billing records. Your prompts, transcripts, files, and memory are not on that list. Change anytime in Settings → Privacy." Link: `Learn how we use data`.

### Stage 3 — Permissions (3 screens) — *mirrors Wispr exactly*

**7. Microphone.** Card: "Allow June to use your microphone — June only listens while you hold the hotkey or while a meeting note is recording." `Allow` + ⓘ. Right: screencast of the macOS mic dialog with cursor moving to OK.

**8. Accessibility.** Card: "Allow June to type for you — this lets June put your spoken words into whatever app you're using." Right: screencast of System Settings → Privacy & Security → Accessibility with the June toggle flipping.

**9. Trust recap.** "Thanks for trusting us — here's the full picture." Checkmark cards: `June can use your microphone ✓` `June can type anywhere ✓`. Below, two *preview* cards (greyed, no checkmark): `System audio — macOS will ask the first time you record a meeting` and `Your files — the agent asks before it touches anything`. This is the screen that converts the permissions stage from extraction into a contract.

### Stage 4 — Set up (3 screens) — *same as Wispr*

**10. Test your microphone.** "Do you see green bars while you speak?" Live level meter. `Change microphone` / `Yes`. Sub: "We recommend built-in or wired microphones — Bluetooth is less reliable."

**11. Set the languages you speak.** "June works in 100+ languages."

**12. Test the hotkey.** "Hold `fn` — does the key light up while you press it?" `Edit shortcut` / `No` / `Yes`.

### Stage 5 — Learn (8 screens) — *dictation hands-on, then notes, then the agent*

**Dictation (4 screens, Wispr's playbook):**

**13. Explainer.** "June starts listening when you hold `fn` — it types what you said when you let go." Animated demo over a real-looking app.

**14. Practice 1 — reply to a message.** Simulated chat app, incoming "Hey {name}, what's up?" Prompt: "Hold `fn`, say something, then release."

**15. Practice 2 — write an email, hands free.** Simulated email. Guided script: *"Umm hi Greg. Let's connect soon. Are you available Friday at 3, no actually 4? Best, {name}."* The output appears clean — no "umm," the time reads 4. Caption: "June formats for you and fixes your mistakes." (This single rep teaches the entire value prop of AI-cleaned dictation.)

**16. Reward.** Dark screen: "Nice job! You just spoke **{n}× faster** than the average typist." Then the time-saved slider: "With June you could save **{x} hours a week**."

**Meeting notes (2 screens, show-don't-tell):**

**17. Demo.** "Never take notes again." A 20-second simulated meeting plays (two voices, audio optional) while a notes panel assembles itself live: **Decisions**, **Action items (with owners)**, **Who said what**. Footer: "Transcripts and notes stay on your Mac." This is watched, not practiced — there's no real meeting to practice on.

**18. Choice.** "How should meeting notes start?" Two cards: **Detect my meetings** ("June notices when a meeting starts and offers to take notes — you always see a recording indicator") / **I'll start them manually** (menu-bar button + hotkey). Either way: "The first time, macOS will ask for system-audio access — that's the permission we mentioned."

**Agent (2 screens — intro + the honesty screen):**

**19. Intro.** "Hand off real work." Copy: "Give June a task, not just a question. Draft the doc, dig through the files, pull the research together — the agent works on your Mac and comes back with it done." Right panel: the approval-card preview from the landing page — *"June found the file and prepared the edit. Nothing changes until you say yes."* `Approve` / `Decline`.

**20. The honesty screen.** (Full copy in §4 below.) States plainly that the agent can make mistakes, explains what guardrails exist, and draws the line between private inference and the consequences of agent actions. Ends with an explicit acknowledgment checkbox — a seatbelt moment, not a EULA. This screen is *not skippable*; it gates the agent feature, not the app.

### Stage 6 — Personalize & finish (3 screens)

**21. First agent task (optional, seeded by screen 4).** "Want to hand June its first task?" Three suggestion chips matched to their selections, all read-only-safe: "Summarize everything in a folder I pick" · "Research a topic and draft a one-pager" · "Prep a brief for my next meeting." Choosing one drops the user into the real agent UI with the approval pattern visible. `Skip for now` is prominent — this can also be the post-onboarding modal's job.

**22. Team.** "{n} people from your company are using June" → create team / invite. (Privacy-conscious: shown only from same-domain signups, with the same opt-out Wispr offers.)

**23. Done → main app**, which opens the "What would you like June to do first?" modal: `Write something by voice` · `Take notes in my next meeting` · `Give the agent a task`, each deep-linking into the real feature.

## 4. The two copy moments that carry the requirements

### Screen 5 — privacy education (adapted from landing copy)

> **Private by architecture, not by promise.**
> Every layer of June defaults to private. The ones that matter most, you can verify.
>
> **Local by default.** The agent runs on your Mac, built on open-source Hermes. Your files, sessions, and memory stay on your disk.
> **Private inference.** Prompts leave your Mac only for model inference, routed by default to zero-retention models — nothing stored, nothing trained on. Third-party models are opt-in, with your identity stripped.
> **Verifiable.** Open-source code, TEE-attested backend. Check it yourself — don't take our word for it.

### Screen 20 — the honesty screen (agent risks + the inference/agent distinction)

> **Before you meet the agent, three honest things.**
>
> **1. The agent can make mistakes.**
> It's powerful, and that means it can misread a file, take a wrong step, or sound confident while being wrong. Treat its work like a sharp new hire's: useful, fast, and worth a glance before it ships.
>
> **2. So nothing irreversible happens without you.**
> The agent asks before it edits or deletes files, sends anything, or spends anything. Every session has a full activity log, and you can stop it at any moment. Nothing changes until you say yes.
>
> **3. Private inference protects your data — it doesn't approve the agent's actions.**
> When June *thinks*, your prompts go to zero-retention models: nothing stored, nothing trained on. That's the privacy of inference, and it's always on.
> When the agent *acts* — visits a website, calls a tool you've connected, sends an email you approved — the other side sees what it shares, exactly as if you'd done it yourself. June keeps your data private; it can't make the rest of the internet private. That's why you're the approval step.
>
> ☐ I understand the agent can make mistakes, and I stay in control of what it does.
> `Meet the agent`

The structural insight this screen encodes: **inference privacy is a property of June (always on, verifiable); action risk is a property of what you authorize the agent to do (scoped, approved, logged).** Two different layers, two different mitigations — and the user leaves onboarding able to articulate both.

## 5. Success metrics

- **Activation:** % completing first dictation rep (target: match Wispr-class ~85%+ of permission-granters); % reaching the reward screen.
- **Per-stage drop-off**, especially screens 5–6 (does the privacy stage cost completion?) and screen 20 (does the honesty screen scare people off the agent — or increase first-task rates, as informed consent usually does?).
- **Permission grant rates** (mic, accessibility at onboarding; system audio + file scope at just-in-time) — JIT asks should outperform 80%+.
- **Feature adoption at day 7:** dictated ≥3 days, ≥1 meeting note, ≥1 agent task.
- **Comprehension probe (qualitative/UXR):** can users answer "what does June store about you?" and "what's the difference between June's privacy and the agent emailing someone?"

## 6. Open questions

1. **Hotkey default** — assumed `fn` like Wispr; does June have its own (and is fn already claimed by Wispr on machines running both)?
2. **Meeting-notes demo audio** — real recorded scene vs. silent animated transcript? (Audio is far more convincing; needs production.)
3. **Screen 21 first-agent-task** — in onboarding (recommended, optional) or fully deferred to the post-onboarding modal?
4. **Time-saved projection numbers** — need real WPM/typing-time model before shipping the reward screen claims.
5. **Team detection** — does the same-domain lookup conflict with the privacy positioning? (Recommend: only surface counts, never names, until invited.)

---

## 7. Membership funnel integration (2026-06-10)

The original wizard treated sign-up and the free trial as someone else's
problem — sign-in lived on a separate gate before the wizard, and the trial
was a second gate that bounced users through the accounts portal:

> open app → sign up in browser → return → **click "Start free trial"** →
> land on the portal home → **find and click "Start free trial" again** →
> Stripe Checkout → pay → **manually find your way back to the app**.

Three clicks and a navigation dead-end between a signed-up user and a paying
one. The redesign folds both into the wizard and removes every step that
doesn't earn its keep:

### The new funnel

Progress bar: **Welcome → Privacy → Permissions → Set up → Free trial → Learn → Finish**

1. **Welcome doubles as sign-up (step 1).** The old standalone AccountGate
   became the wizard's first step, so the progress bar frames the very first
   screen — users see the whole map before committing. The browser handoff
   returns via the `osscribe://` deep link; the step flips to a
   "Welcome, {name}!" greeting on its own.
2. **The trial ask moved to *after* permissions and setup, right before the
   hands-on practice.** Two reasons:
   - *Investment*: by the trial screen the user has granted two permissions
     and configured their hotkey — maximum sunk cost before the card ask.
   - *Necessity + payoff*: the dictation practice runs the real, metered
     pipeline, so it needs the trial's credits — and it means the magic
     moment lands seconds after payment, not before it.
3. **One click to Stripe, no portal page.** The app mints the subscription
   Checkout session itself (`POST /billing/subscription` with the user's own
   token — requires the `billing:write` scope) and opens the Stripe URL
   directly. The portal's "Start free trial" page is gone from the path. If
   the direct mint fails (older token without the scope, subscriptions
   disabled), the app falls back to opening the portal — nobody is stranded.
4. **The return trip is automatic — twice over.** Release builds ask the
   accounts API for a `return_url` of `osscribe://billing/callback`, so
   Stripe's success page (via the portal's `/return` bounce) deep-links
   straight back into June, which refreshes the subscription on the spot; a
   checkout cancel returns to the trial pitch with a friendly note, not an
   error. Independently, while checkout is open the app polls the
   subscription status every 2.5s and pulls itself to the foreground
   (`focus_main_window`) the instant it flips to `trialing` — so the loop
   closes even on deployments without the return-url allowlist, where the
   API 422s the `return_url` and the app retries without it.
5. **Resume on relaunch.** The wizard persists the current step
   (`june.onboarding.resumeStep`), so quitting mid-checkout doesn't replay
   the whole flow. Steps re-verify their own state: the sign-in step skips
   itself when signed in, the trial step skips itself when a subscription is
   already live (which also makes wizard re-runs after a version bump cheap
   for existing members).

### Post-onboarding gates

AccountGate (signed out) and TrialGate (lapsed/canceled/past-due) remain for
users who finished onboarding. TrialGate now uses the same one-click
checkout + auto-detect machinery (`src/lib/trial-checkout.ts`); past-due
still routes to the portal's billing management.

### Server dependencies

- The June OAuth client's `allowed_scopes` in the OS Accounts admin console
  must include `billing:write`, or every direct checkout falls back to the
  portal flow. Tokens issued before this change lack the scope until the
  next sign-in; the fallback covers them.
- The accounts deployment needs `osscribe://` in its
  `server.allowed_return_url_prefixes` (os-accounts PR adding `return_url`
  support to the checkout endpoints) for the deep-link return; without it
  the app silently retries checkout creation without a `return_url` and the
  poll-based return takes over.
