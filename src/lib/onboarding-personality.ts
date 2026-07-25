import type { OnboardingArea, OnboardingPersonality } from "./onboarding";

type PreviewBand = readonly [string, string, string, string, string];

type PreviewScenario = {
  opening: PreviewBand;
  body: PreviewBand;
  humor: PreviewBand;
  nextAction: string;
  quietEnds: readonly [string, string, string, string, string];
};

export type PersonalityStyleCopy = {
  id: OnboardingArea;
  name: string;
  description: string;
};

const STYLE_ORDER: readonly OnboardingArea[] = ["work", "thinking", "personal", "play"];

const STYLE_COPY: Record<
  OnboardingArea,
  Record<OnboardingArea, Omit<PersonalityStyleCopy, "id">>
> = {
  work: {
    work: {
      name: "Clearheaded co-pilot",
      description: "Polished, decisive, and one step ahead.",
    },
    thinking: {
      name: "Strategic sounding board",
      description: "Thorough, measured, and sharp.",
    },
    personal: {
      name: "Calm collaborator",
      description: "Warm, practical, and easy to work with.",
    },
    play: {
      name: "Quick-witted operator",
      description: "Fast, candid, and a little irreverent.",
    },
  },
  personal: {
    work: {
      name: "Practical life co-pilot",
      description: "Clear, organized, and gently proactive.",
    },
    thinking: {
      name: "Thoughtful confidant",
      description: "Reflective, patient, and steady.",
    },
    personal: {
      name: "Easygoing companion",
      description: "Warm, relaxed, and supportive.",
    },
    play: {
      name: "Playful sidekick",
      description: "Light, funny, and up for anything.",
    },
  },
  thinking: {
    work: {
      name: "Clear editor",
      description: "Precise, structured, and direct.",
    },
    thinking: {
      name: "Thoughtful partner",
      description: "Curious, nuanced, and unhurried.",
    },
    personal: {
      name: "Gentle sounding board",
      description: "Warm, open, and encouraging.",
    },
    play: {
      name: "Creative provocateur",
      description: "Surprising, playful, and willing to push.",
    },
  },
  play: {
    work: {
      name: "Steady game master",
      description: "Clear, immersive, and keeps things moving.",
    },
    thinking: {
      name: "Worldbuilding partner",
      description: "Detailed, curious, and consistent.",
    },
    personal: {
      name: "Cozy companion",
      description: "Warm, collaborative, and low-pressure.",
    },
    play: {
      name: "Playful wildcard",
      description: "Quirky, surprising, and fully committed.",
    },
  },
};

export const PERSONALITY_STEP_SUBTITLES: Record<OnboardingArea, string> = {
  work: "Pick how I should show up when work gets busy, or drag any point.",
  personal: "Pick how I should show up when life gets messy, or drag any point.",
  thinking: "Pick how I should think alongside you, or drag any point.",
  play: "Pick how I should join the fun, or drag any point.",
};

const PREVIEW_SCENARIOS: Record<OnboardingArea, readonly PreviewScenario[]> = {
  work: [
    {
      opening: [
        "I turned your meeting into a clear brief.",
        "I pulled together a polished recap of your meeting.",
        "I pulled the useful parts out of your meeting.",
        "I cleaned up the meeting and kept the useful bits.",
        "I cleaned up that meeting for you.",
      ],
      body: [
        "Launch Tuesday. Maya owns the follow-up.",
        "Decision: launch Tuesday. Maya owns the follow-up.",
        "The team chose Tuesday for launch. Maya will send the final checklist tomorrow.",
        "The team chose Tuesday for launch. Maya owns the checklist, and pricing still needs an owner.",
        "The team chose Tuesday for launch after checking support coverage. Maya owns the final checklist and will send it tomorrow. Pricing still needs an owner.",
      ],
      humor: [
        "I'll keep this straightforward.",
        "Clean and to the point.",
        "One less thing to keep in your head.",
        "The meeting did, eventually, produce a decision.",
        "The launch date survived another meeting.",
      ],
      nextAction: "draft the follow-up",
      quietEnds: [
        "I'll leave it there.",
        "That's everything you need.",
        "No extra homework.",
        "You can take it from here.",
        "I'll stay out of the way.",
      ],
    },
    {
      opening: [
        "I sorted the inbox thread into a decision.",
        "I made the email thread easier to scan.",
        "I found the answer buried in that email chain.",
        "I untangled the thread and kept what matters.",
        "I rescued the useful part from the reply-all wilderness.",
      ],
      body: [
        "Approve the revised budget. Reply to Priya.",
        "The revised budget is ready for approval. Priya needs your reply.",
        "Finance accepted the revised budget. Priya needs your approval before 3 p.m.",
        "Finance accepted the revised budget, but Priya still needs your approval before 3 p.m. The vendor question can wait.",
        "Finance accepted the revised budget after removing the rush fee. Priya needs your approval before 3 p.m. The vendor question is separate and can wait until tomorrow.",
      ],
      humor: [
        "I'll keep it clean.",
        "No inbox archaeology required.",
        "You can ignore the rest of the thread.",
        "Twelve replies, one useful sentence.",
        "The reply-all chain has been safely contained.",
      ],
      nextAction: "write the reply to Priya",
      quietEnds: [
        "That is the whole decision.",
        "You have what you need.",
        "The rest can wait.",
        "I'll leave the reply to you.",
        "No need to reopen the thread.",
      ],
    },
    {
      opening: [
        "I cleaned up your dictated project update.",
        "I shaped your dictation into a clear update.",
        "I turned your rough update into something sendable.",
        "I kept your voice and fixed the wandering bits.",
        "Your voice note now sounds like you on a very organized day.",
      ],
      body: [
        "Design is done. Engineering starts Monday. The date is unchanged.",
        "Design is complete, engineering starts Monday, and the launch date is unchanged.",
        "Design is complete. Engineering starts Monday, and the team is still on track for the planned launch.",
        "Design is complete and engineering starts Monday. The launch date is unchanged, though QA needs the final test plan by Thursday.",
        "Design is complete, engineering starts Monday, and the launch date is still on track. QA needs the final test plan by Thursday, and the only open risk is the billing migration.",
      ],
      humor: [
        "No filler.",
        "Clean enough to send.",
        "Your point survived the cleanup.",
        "All signal, much less throat-clearing.",
        "The three-minute voice note is now doing one minute of work.",
      ],
      nextAction: "turn it into a Slack update",
      quietEnds: [
        "It is ready as written.",
        "You can send it from here.",
        "I won't add anything else.",
        "The update can stand on its own.",
        "Done and ready.",
      ],
    },
  ],
  personal: [
    {
      opening: [
        "I organized what you shared into a practical plan.",
        "I put what you shared into a clear order.",
        "I sorted through what you shared.",
        "I helped make that feel a little lighter.",
        "I untangled that with you.",
      ],
      body: [
        "Book the dentist first. Leave the insurance form for Friday.",
        "Start with the dentist appointment. The insurance form can wait until Friday.",
        "Book the dentist first, then set aside Friday for the insurance form. Everything else can wait.",
        "The dentist is the time-sensitive part. Book it first, save Friday for insurance, and move the rest to next week.",
        "The dentist appointment is the only time-sensitive piece. Book that first, keep Friday for the insurance form, and leave the rest for next week. Nothing else needs your attention today.",
      ],
      humor: [
        "I'll keep this practical.",
        "No extra pressure.",
        "Your week can breathe again.",
        "The paperwork can wait its turn.",
        "Your admin pile has officially been demoted.",
      ],
      nextAction: "make a short checklist",
      quietEnds: [
        "We can leave it there.",
        "That is enough for today.",
        "Nothing else needs doing now.",
        "Take the first step when you are ready.",
        "The rest can wait.",
      ],
    },
    {
      opening: [
        "I found a calmer shape for your week.",
        "I put the week in an order that fits.",
        "I made room for the things you kept squeezing in.",
        "I moved the week around so it stops fighting you.",
        "I negotiated a small peace treaty with your calendar.",
      ],
      body: [
        "Move the grocery run to Wednesday. Keep Thursday night free.",
        "Do groceries Wednesday and protect Thursday night. Dinner with Alex still fits Friday.",
        "Move groceries to Wednesday, keep Thursday night free, and leave dinner with Alex on Friday.",
        "Wednesday can hold groceries and the pharmacy. Keep Thursday night empty, then dinner with Alex still works Friday without rushing.",
        "Wednesday has enough room for groceries and the pharmacy after work. Keep Thursday night empty, and dinner with Alex can stay Friday. Saturday morning remains open for anything that slips.",
      ],
      humor: [
        "No calendar gymnastics.",
        "A week with breathing room.",
        "You get an evening back.",
        "Thursday has been rescued from accidental plans.",
        "Your calendar has agreed to stop behaving like airport Tetris.",
      ],
      nextAction: "write out the plan for the week",
      quietEnds: [
        "The week works as-is.",
        "You can stop rearranging it.",
        "That is a workable plan.",
        "Nothing needs squeezing in.",
        "Your calendar can rest now.",
      ],
    },
    {
      opening: [
        "I kept the thought and cleared away the noise.",
        "I turned what you said into a private note.",
        "I wrote down the part you may want to remember.",
        "I stayed with what was bothering you.",
        "I gave the late-night spiral a much shorter ending.",
      ],
      body: [
        "You are tired, not failing. Decide tomorrow.",
        "You sound tired, not certain. You can decide tomorrow.",
        "The worry got louder because you are tired. Nothing here needs a decision tonight.",
        "You are treating tonight's exhaustion like evidence that the plan is wrong. Sleep first, then look at the decision again tomorrow.",
        "The plan may still need changing, but tonight's exhaustion is making every option look worse. Nothing is urgent. Sleep first, then revisit the decision with a clearer head tomorrow.",
      ],
      humor: [
        "I'll keep it gentle.",
        "No forced silver lining.",
        "Your brain can clock out now.",
        "Midnight is a terrible career adviser.",
        "The 1 a.m. board meeting in your head is adjourned.",
      ],
      nextAction: "save this as a private journal entry",
      quietEnds: [
        "You can leave it here tonight.",
        "No decision is needed now.",
        "Rest is enough for the moment.",
        "We can come back tomorrow.",
        "Let the thought settle.",
      ],
    },
  ],
  thinking: [
    {
      opening: [
        "I organized what you wrote into a clearer reflection.",
        "I gave your notes a clearer shape.",
        "I found the thought underneath your brain-dump.",
        "I followed the thread hiding in what you wrote.",
        "There is something real in that brain-dump.",
      ],
      body: [
        "You don't miss the old job. You miss feeling useful without being exhausted.",
        "You miss feeling useful, not the old job itself. You're wary of repeating the same exhaustion.",
        "You don't seem to miss the old job itself. You miss feeling useful without being exhausted, and you're worried a new role will repeat the same pattern.",
        "You miss the feeling of being useful more than the job. The tension is whether a new role offers balance or only a more exciting version of the same pattern.",
        "You don't seem to miss the old job itself. You miss feeling useful without being exhausted. The harder question is whether a new role would give you that balance or repeat the same pattern with a different title.",
      ],
      humor: [
        "I'll stay with the hard part.",
        "No neat answer pasted over it.",
        "That thought was hiding in plain sight.",
        "Your brain took the scenic route, but it got somewhere.",
        "Your brain buried the lead.",
      ],
      nextAction: "turn this into a journal entry",
      quietEnds: [
        "You can sit with that.",
        "No answer is required yet.",
        "That is the honest version.",
        "The thought can stay unfinished.",
        "We can leave the question open.",
      ],
    },
    {
      opening: [
        "I found the argument inside your rough draft.",
        "I gave the draft a clearer spine.",
        "I pulled the strongest idea to the front.",
        "I kept your point and cut the polite fog around it.",
        "I found the sentence your draft was trying to become.",
      ],
      body: [
        "The product saves time because it remembers context.",
        "The main point is that remembered context removes repeated setup.",
        "The product saves time because people stop rebuilding context at the start of every task.",
        "Your strongest claim is not speed alone. The product remembers enough context that people can continue work instead of explaining it again.",
        "The draft is strongest when it stays concrete: the product remembers past decisions, notes, and preferences, so people can continue a task without rebuilding the context every time.",
      ],
      humor: [
        "I'll keep the claim plain.",
        "No grand manifesto needed.",
        "The good sentence was already in there.",
        "The draft can stop wearing a blazer indoors.",
        "I removed three paragraphs of very professional weather.",
      ],
      nextAction: "rewrite the opening paragraph",
      quietEnds: [
        "The argument is clear now.",
        "You can take the draft from here.",
        "That is the sentence to keep.",
        "The rest is editing.",
        "I will leave the voice with you.",
      ],
    },
    {
      opening: [
        "I laid out the decision without pretending it is easy.",
        "I put the tradeoffs where you can see them.",
        "I separated the real decision from the surrounding anxiety.",
        "I found the choice hiding under all the caveats.",
        "I made your impossible decision slightly less theatrical.",
      ],
      body: [
        "Option A is safer. Option B gives you more room to grow.",
        "Option A protects your time. Option B offers more growth but asks more of you.",
        "Option A protects your time and gives you predictability. Option B offers more growth, with a higher risk of repeating the workload you want to leave.",
        "The decision turns on what you are protecting this year. Option A protects time and stability. Option B creates more growth, but the workload risk is real.",
        "Both options are credible. Option A protects time, stability, and recovery. Option B offers faster growth and stronger work, but it may recreate the pace you are trying to leave. The deciding question is which cost you are more willing to carry this year.",
      ],
      humor: [
        "I'll keep the scales level.",
        "No fake certainty.",
        "At least the tradeoff has a name now.",
        "Your spreadsheet was trying to make an emotional decision.",
        "The pros-and-cons list has been relieved of jury duty.",
      ],
      nextAction: "ask you the deciding question",
      quietEnds: [
        "You have the tradeoff.",
        "Take your time with it.",
        "The choice does not need forcing.",
        "That is enough to think about.",
        "The decision is still yours.",
      ],
    },
  ],
  play: [
    {
      opening: [
        "I turned your idea into a character you can play.",
        "I shaped your idea into a character with somewhere to go.",
        "I gave your character a voice and a few secrets.",
        "I gave your character a past, a problem, and one suspicious oven.",
        "Okay, your character is already trouble.",
      ],
      body: [
        "Mara is a retired dragon hunter who now runs a bakery.",
        "Mara is a retired dragon hunter who runs a bakery at the edge of town.",
        "Mara is a retired dragon hunter who runs a bakery and insists the oven is haunted. She is probably right.",
        "Mara runs a bakery at the edge of town, keeps a sword under the flour sacks, and knows the oven is haunted.",
        "Mara is a retired dragon hunter who now runs a bakery on the edge of town. She keeps a sword under the flour sacks, insists the oven is haunted, and refuses to explain why the mayor owes her three favors.",
      ],
      humor: [
        "I'll keep the world grounded.",
        "Just strange enough to feel alive.",
        "I can make it strange without losing the plot.",
        "The oven has opinions. None of them are helpful.",
        "The haunted oven is already unionizing.",
      ],
      nextAction: "play the first customer who walks in",
      quietEnds: [
        "Mara can wait at the bakery door.",
        "The scene is yours.",
        "We can leave her here for now.",
        "The oven is behaving for the moment.",
        "The story can pause here.",
      ],
    },
    {
      opening: [
        "I set the first scene and left you room to move.",
        "I gave the role-play a clean opening.",
        "I dropped you into the moment before everything changes.",
        "I opened the door and made sure something strange was behind it.",
        "Your quiet evening has been professionally ruined.",
      ],
      body: [
        "Rain hits the station windows. A package waits on your seat.",
        "Rain rattles the last train. An unmarked package is waiting on your seat.",
        "You board the last train in the rain. An unmarked package sits on your seat, addressed in your own handwriting.",
        "The last train is empty except for an unmarked package on your seat. It is addressed in your handwriting and ticking very softly.",
        "You board the last train as the city disappears into rain. An unmarked package waits on your seat, addressed in your own handwriting. Inside, something ticks in time with the carriage lights.",
      ],
      humor: [
        "I'll keep the tension clean.",
        "Nothing good ever waits on the last train.",
        "A normal commute was apparently too much to ask.",
        "The rail company does not list cursed parcels as an amenity.",
        "Five stars for atmosphere. One star for unattended temporal luggage.",
      ],
      nextAction: "play the conductor when you open the package",
      quietEnds: [
        "The next move is yours.",
        "The package can keep ticking.",
        "We can hold the scene here.",
        "The conductor has not noticed you yet.",
        "The train keeps moving.",
      ],
    },
    {
      opening: [
        "I gave your world one rule worth breaking.",
        "I built a world around the idea you gave me.",
        "I found the rule that makes the setting feel alive.",
        "I made the magic useful, expensive, and slightly inconvenient.",
        "I created an economy powered by bottled memories. This will go well.",
      ],
      body: [
        "People can trade memories for magic, but each memory is gone afterward.",
        "Magic comes from traded memories. The seller loses the memory for good.",
        "People bottle memories and trade them for magic. Wealthy families buy childhoods, while the poor sell pieces of their own.",
        "Magic is powered by bottled memories. The seller forgets each one forever, and old families hoard entire borrowed childhoods.",
        "Every spell consumes a bottled memory, which disappears from its original owner. The wealthy collect other people's childhoods, the poor sell their happiest days, and an illegal market has started returning memories to the wrong minds.",
      ],
      humor: [
        "I'll keep the rules consistent.",
        "Magic should always send an invoice.",
        "The world now has a problem worth exploring.",
        "Naturally, someone has invented memory tax.",
        "The treasury insists stolen nostalgia is still taxable income.",
      ],
      nextAction: "create the first person who refuses to sell a memory",
      quietEnds: [
        "The world is ready when you are.",
        "The rule can sit there for now.",
        "You have enough to start.",
        "The first character is still yours.",
        "The market opens at dawn.",
      ],
    },
  ],
};

const OPENING_LEADS = ["", "All set. ", "Done. ", "I've got it. ", "Okay. "] as const;
const DETAIL_LEADS = [
  "",
  "In short, ",
  "What matters is this. ",
  "The useful part is clear. ",
  "Here is the shape of it. ",
] as const;
const HUMOR_LEADS = ["", "Also, ", "And yes, ", "Small aside. ", "For the record, "] as const;

function clampSpectrum(value: number) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function band(value: number) {
  return Math.round(clampSpectrum(value) / 25);
}

function exact<T>(values: readonly T[], value: number) {
  return values[clampSpectrum(value) % values.length];
}

function lowercaseFirst(value: string) {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function sentenceWithLead(leads: readonly string[], value: number, sentence: string) {
  const lead = exact(leads, value);
  return lead ? `${lead}${lowercaseFirst(sentence)}` : sentence;
}

function initiativeLine(scenario: PreviewScenario, value: number) {
  const normalized = clampSpectrum(value);
  const intensity = band(normalized);
  const action = scenario.nextAction;
  const variation = normalized % 5;

  if (intensity === 0) return exact(scenario.quietEnds, normalized);

  const variants =
    intensity === 1
      ? [
          `I can ${action} if you want.`,
          `If you'd like, I can ${action}.`,
          `I can also ${action}.`,
          `We can ${action} whenever you're ready.`,
          `Say the word and I can ${action}.`,
        ]
      : intensity === 2
        ? [
            `I can ${action} next.`,
            `A useful next step would be to ${action}.`,
            `We could ${action} from here.`,
            `I can take the next step and ${action}.`,
            `The next useful move is to ${action}.`,
          ]
        : intensity === 3
          ? [
              `I can go ahead and ${action}.`,
              `I would ${action} next.`,
              `The next move is to ${action}, and I can handle it.`,
              `I can keep this moving and ${action}.`,
              `From here, I can ${action}.`,
            ]
          : [
              `Want me to ${action}?`,
              `Should I ${action}?`,
              `Ready for me to ${action}?`,
              `I can ${action} now. Want me to?`,
              `I think we should ${action} next. Shall I?`,
            ];

  return variants[variation];
}

function scenarioFor(area: OnboardingArea, personality: OnboardingPersonality) {
  const scenarios = PREVIEW_SCENARIOS[area];
  const weighted =
    clampSpectrum(personality.voice) +
    clampSpectrum(personality.detail) * 2 +
    clampSpectrum(personality.initiative) * 3 +
    clampSpectrum(personality.humor) * 5;
  return scenarios[Math.floor(weighted / 80) % scenarios.length];
}

export function personalityStylesForArea(area: OnboardingArea): readonly PersonalityStyleCopy[] {
  return STYLE_ORDER.map((id) => ({ id, ...STYLE_COPY[area][id] }));
}

/**
 * Builds the live sample from four independent sentence parts. The semantic
 * bands make large moves feel meaningfully different, while the exact-value
 * cadence variants make every adjacent graph value produce visible feedback.
 */
export function personalityPreviewMessage(
  area: OnboardingArea,
  personality: OnboardingPersonality,
) {
  const scenario = scenarioFor(area, personality);
  const opening = `${exact(OPENING_LEADS, personality.voice)}${
    scenario.opening[band(personality.voice)]
  }`;
  const body = sentenceWithLead(
    DETAIL_LEADS,
    personality.detail,
    scenario.body[band(personality.detail)],
  );
  const humor = sentenceWithLead(
    HUMOR_LEADS,
    personality.humor,
    scenario.humor[band(personality.humor)],
  );

  return [opening, body, humor, initiativeLine(scenario, personality.initiative)].join(" ");
}
