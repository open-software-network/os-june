import { IconArrowInbox } from "central-icons/IconArrowInbox";
import { IconBroomSparkle } from "central-icons/IconBroomSparkle";
import { IconCalendarCheck } from "central-icons/IconCalendarCheck";
import { IconCloudySun } from "central-icons/IconCloudySun";
import { IconNewspaper } from "central-icons/IconNewspaper";

/** A starter routine: opens the create editor prefilled, never creates
 * directly — prompts carry [bracketed] placeholders the user fills in, and
 * the schedule is only a sensible default. */
export type RoutineTemplate = {
  id: string;
  name: string;
  /** Card copy: what you get, one sentence. */
  description: string;
  prompt: string;
  schedule: string;
  /** Templates whose job needs machine access (files, terminal). The editor
   * preselects Unrestricted and the card carries the warm badge so the
   * access cost is visible before anything is created. */
  unrestricted?: boolean;
  icon: typeof IconArrowInbox;
};

export const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  {
    id: "morning-brief",
    name: "Morning brief",
    description:
      "Open loops from recent sessions, your todos, and anything new that matters.",
    prompt:
      "Put together a short morning brief. Look through my recent sessions and notes for open loops and unanswered questions, list my open todos, and check the web for anything new that clearly matters for my work. Keep it under 200 words.",
    schedule: "0 8 * * 1-5",
    icon: IconCloudySun,
  },
  {
    id: "weekly-review",
    name: "Weekly review",
    description:
      "A Friday afternoon summary of the week's work and what to carry forward.",
    prompt:
      "Write my weekly review. Summarize what I worked on this week from my sessions and notes, call out decisions that got made, and list the open loops worth carrying into next week.",
    schedule: "0 16 * * 5",
    icon: IconCalendarCheck,
  },
  {
    id: "news-watch",
    name: "News watch",
    description:
      "Track a topic and only hear about it when something actually happens.",
    prompt:
      "Check the web for news about [topic]. Summarize anything genuinely new since the last run, with links. If nothing meaningful happened, reply with one line saying so.",
    schedule: "0 9 * * *",
    icon: IconNewspaper,
  },
  {
    id: "memory-tidy",
    name: "Memory tidy",
    description:
      "A weekly pass over June's memory to merge duplicates and drop stale facts.",
    prompt:
      "Review your memories from the past week. Consolidate duplicates, flag anything stale or contradictory, and summarize what you changed.",
    schedule: "0 18 * * 0",
    icon: IconBroomSparkle,
  },
  {
    id: "downloads-tidy",
    name: "Tidy downloads",
    description:
      "Sort the Downloads folder into subfolders by type every Friday.",
    prompt:
      "Tidy my Downloads folder: sort loose files into subfolders by type (images, documents, archives, installers). List anything older than 30 days that looks like junk I could delete, but do not delete anything yourself.",
    schedule: "0 17 * * 5",
    unrestricted: true,
    icon: IconArrowInbox,
  },
];
