// Shared by the "Did this fix it?" prompt (client) and the feedback and handoff routes (server validation).
export const FEEDBACK_REASONS = {
  didnt_work: "I tried it and it didn't work",
  incorrect: "Incorrect",
  incomplete: "Missing steps",
  not_answered: "Didn't answer my question",
  // Only on older thumbs-down records; the chat no longer offers these
  needed_person: "Should have connected me to a person",
  unneeded_handoff: "Didn't need a person",
} as const;
export type FeedbackReason = keyof typeof FEEDBACK_REASONS;

// Offered when a customer says an answer didn't fix their problem
export const STUCK_REASONS = ["didnt_work", "incomplete", "incorrect", "not_answered"] as const satisfies readonly FeedbackReason[];
export type StuckReason = (typeof STUCK_REASONS)[number];

// What the customer reported after an answer
export type OutcomeResult = "resolved" | "stuck" | "unneeded_handoff";
