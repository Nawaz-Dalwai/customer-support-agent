// Shared by the thumbs-down menu (client) and the feedback route (server validation).
export const FEEDBACK_REASONS = {
  incorrect: "Incorrect",
  not_answered: "Didn't answer my question",
  incomplete: "Missing steps",
  needed_person: "Should have connected me to a person",
  unneeded_handoff: "Didn't need a person",
} as const;
export type FeedbackReason = keyof typeof FEEDBACK_REASONS;
