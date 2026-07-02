// Kill switch from the RC hide (PR #555). On again now that JUN-171 closes the
// gaps that kept image generation out of the release: fast-path images enter
// the model's context, and generation/editing work as LLM tools.
export const IMAGE_GENERATION_ENABLED = true;
