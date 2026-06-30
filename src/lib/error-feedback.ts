export type ErrorFeedbackCategory = "bug" | "feedback" | "feature";

export type ErrorFeedbackRequestedDetail = {
  category: ErrorFeedbackCategory;
};

export const ERROR_FEEDBACK_REQUESTED_EVENT = "june:error-feedback-requested";

export function requestErrorFeedback(category: ErrorFeedbackCategory = "bug") {
  window.dispatchEvent(
    new CustomEvent<ErrorFeedbackRequestedDetail>(
      ERROR_FEEDBACK_REQUESTED_EVENT,
      { detail: { category } },
    ),
  );
}

export function errorFeedbackCategoryFromDetail(
  detail: unknown,
): ErrorFeedbackCategory {
  if (
    detail &&
    typeof detail === "object" &&
    "category" in detail &&
    isErrorFeedbackCategory((detail as { category: unknown }).category)
  ) {
    return (detail as { category: ErrorFeedbackCategory }).category;
  }
  return "bug";
}

function isErrorFeedbackCategory(
  category: unknown,
): category is ErrorFeedbackCategory {
  return (
    category === "bug" || category === "feedback" || category === "feature"
  );
}
