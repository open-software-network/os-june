#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Question {
    GeneralActiveDays,
    NotesMeetingsRecorded,
    NotesAudioSource,
    DictationSessions,
    AgentSessions,
    AgentPrivacyGuard,
    ModelsPrivacyMode,
    OnboardingCompleted,
    OnboardingUseCaseWork,
    OnboardingUseCasePersonal,
    OnboardingUseCaseSchool,
    OnboardingUseCaseCreative,
    OnboardingUseCaseCoding,
    OnboardingUseCaseMeetings,
    OnboardingUseCaseOther,
    OnboardingUseCaseNotSure,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QuestionDef {
    pub question: Question,
    pub id: &'static str,
    pub prompt: &'static str,
    pub buckets: &'static [&'static str],
    pub decision: &'static str,
}

pub const ALL_QUESTIONS: &[QuestionDef] = &[
    QuestionDef {
        question: Question::GeneralActiveDays,
        id: "general.active-days",
        prompt: "Days June was opened this week",
        buckets: &["0", "1", "2-3", "4-5", "6-7"],
        decision: "Engagement baseline for all other ratios",
    },
    QuestionDef {
        question: Question::NotesMeetingsRecorded,
        id: "notes.meetings-recorded",
        prompt: "Meeting recording completed",
        buckets: &["event"],
        decision: "Investment in meetings pipeline",
    },
    QuestionDef {
        question: Question::NotesAudioSource,
        id: "notes.audio-source",
        prompt: "Most-used audio source this week",
        buckets: &["none", "mic only", "mic + system"],
        decision: "System-audio maintenance cost",
    },
    QuestionDef {
        question: Question::DictationSessions,
        id: "dictation.sessions",
        prompt: "Dictation session completed",
        buckets: &["event"],
        decision: "Dictation as flagship vs. niche",
    },
    QuestionDef {
        question: Question::AgentSessions,
        id: "agent.sessions",
        prompt: "Agent session started",
        buckets: &["event"],
        decision: "Agent runtime investment",
    },
    QuestionDef {
        question: Question::AgentPrivacyGuard,
        id: "agent.privacy-guard",
        prompt: "Agent privacy guard mode",
        buckets: &["off", "structured"],
        decision: "Rampart default-on decision",
    },
    QuestionDef {
        question: Question::ModelsPrivacyMode,
        id: "models.privacy-mode",
        prompt: "Most-selected model privacy mode this week",
        buckets: &["e2ee", "private", "anonymous"],
        decision: "Model catalog and TEE roadmap",
    },
    QuestionDef {
        question: Question::OnboardingCompleted,
        id: "onboarding.completed",
        prompt: "Onboarding completed",
        buckets: &["completed"],
        decision: "Onboarding funnel health",
    },
    QuestionDef {
        question: Question::OnboardingUseCaseWork,
        id: "onboarding.use-case.work",
        prompt: "Onboarding interest selected: work",
        buckets: &["selected"],
        decision: "New-user intent and activation segmentation",
    },
    QuestionDef {
        question: Question::OnboardingUseCasePersonal,
        id: "onboarding.use-case.personal",
        prompt: "Onboarding interest selected: personal",
        buckets: &["selected"],
        decision: "New-user intent and activation segmentation",
    },
    QuestionDef {
        question: Question::OnboardingUseCaseSchool,
        id: "onboarding.use-case.school",
        prompt: "Onboarding interest selected: school",
        buckets: &["selected"],
        decision: "New-user intent and activation segmentation",
    },
    QuestionDef {
        question: Question::OnboardingUseCaseCreative,
        id: "onboarding.use-case.creative",
        prompt: "Onboarding interest selected: creative projects",
        buckets: &["selected"],
        decision: "New-user intent and activation segmentation",
    },
    QuestionDef {
        question: Question::OnboardingUseCaseCoding,
        id: "onboarding.use-case.coding",
        prompt: "Onboarding interest selected: coding",
        buckets: &["selected"],
        decision: "New-user intent and activation segmentation",
    },
    QuestionDef {
        question: Question::OnboardingUseCaseMeetings,
        id: "onboarding.use-case.meetings",
        prompt: "Onboarding interest selected: meetings",
        buckets: &["selected"],
        decision: "New-user intent and activation segmentation",
    },
    QuestionDef {
        question: Question::OnboardingUseCaseOther,
        id: "onboarding.use-case.other",
        prompt: "Onboarding interest selected: other",
        buckets: &["selected"],
        decision: "New-user intent and activation segmentation",
    },
    QuestionDef {
        question: Question::OnboardingUseCaseNotSure,
        id: "onboarding.use-case.not-sure",
        prompt: "Onboarding interest selected: not sure yet",
        buckets: &["selected"],
        decision: "New-user intent and activation segmentation",
    },
];

impl Question {
    pub fn from_id(id: &str) -> Option<Self> {
        ALL_QUESTIONS
            .iter()
            .find(|definition| definition.id == id)
            .map(|definition| definition.question)
    }

    pub fn definition(self) -> &'static QuestionDef {
        ALL_QUESTIONS
            .iter()
            .find(|definition| definition.question == self)
            .expect("question definition exists")
    }

    pub fn id(self) -> &'static str {
        self.definition().id
    }

    pub fn bucket(self, raw: u64) -> u8 {
        match self {
            Self::GeneralActiveDays => match raw {
                0 => 0,
                1 => 1,
                2..=3 => 2,
                4..=5 => 3,
                _ => 4,
            },
            Self::NotesMeetingsRecorded => 0,
            Self::NotesAudioSource => match raw {
                0 => 0,
                1 => 1,
                _ => 2,
            },
            Self::DictationSessions => 0,
            Self::AgentSessions => 0,
            Self::AgentPrivacyGuard => {
                if raw == 0 {
                    0
                } else {
                    1
                }
            }
            Self::ModelsPrivacyMode => raw.min(2) as u8,
            Self::OnboardingCompleted
            | Self::OnboardingUseCaseWork
            | Self::OnboardingUseCasePersonal
            | Self::OnboardingUseCaseSchool
            | Self::OnboardingUseCaseCreative
            | Self::OnboardingUseCaseCoding
            | Self::OnboardingUseCaseMeetings
            | Self::OnboardingUseCaseOther
            | Self::OnboardingUseCaseNotSure => 0,
        }
    }

    pub fn event_bucket(self) -> u8 {
        self.bucket(1)
    }
}

#[cfg(test)]
mod tests {
    use super::{Question, ALL_QUESTIONS};

    #[test]
    fn bucketizes_coarse_values() {
        assert_eq!(Question::GeneralActiveDays.bucket(0), 0);
        assert_eq!(Question::GeneralActiveDays.bucket(3), 2);
        assert_eq!(Question::GeneralActiveDays.bucket(7), 4);
        assert_eq!(Question::DictationSessions.bucket(5), 0);
        assert_eq!(Question::DictationSessions.bucket(21), 0);
        assert_eq!(Question::AgentSessions.bucket(10), 0);
        assert_eq!(Question::OnboardingCompleted.bucket(0), 0);
        assert_eq!(Question::OnboardingCompleted.bucket(1), 0);
    }

    #[test]
    fn event_questions_use_single_event_bucket() {
        assert_eq!(Question::NotesMeetingsRecorded.event_bucket(), 0);
        assert_eq!(Question::DictationSessions.event_bucket(), 0);
        assert_eq!(Question::AgentSessions.event_bucket(), 0);
        assert_eq!(Question::OnboardingCompleted.event_bucket(), 0);
        assert_eq!(Question::OnboardingUseCaseWork.event_bucket(), 0);
        assert_eq!(Question::OnboardingUseCaseOther.event_bucket(), 0);
        assert_eq!(Question::OnboardingUseCaseNotSure.event_bucket(), 0);
    }

    #[test]
    fn rejects_unknown_question_ids() {
        assert_eq!(Question::from_id("notes.title"), None);
    }

    #[test]
    fn telemetry_question_docs_match_catalog() {
        let docs = include_str!("../../../docs/telemetry-questions.md");
        for definition in ALL_QUESTIONS {
            let table_id = format!("| `{}` |", definition.id);
            assert!(
                docs.contains(&table_id),
                "{} missing from telemetry-questions.md",
                definition.id
            );
            let bucket_list = definition.buckets.join(" / ");
            assert!(
                docs.contains(&bucket_list),
                "{} buckets do not match telemetry-questions.md",
                definition.id
            );
            assert!(
                docs.contains(definition.decision),
                "{} decision does not match telemetry-questions.md",
                definition.id
            );
        }
    }
}
