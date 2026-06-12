# Lessons

- When a user says a spinner/name change happened elsewhere, honor the latest component name from main while preserving the intended behavior. In this session, the spinner behavior belongs in the trailing agent-session state slot, but the component is `DotSpinner`.
- During drag-preview UI states, keep transient states coherent for the whole pointer gesture. If `display: none` is needed to protect adjacent panels, use a separate opening state instead of flipping the element visible on the next pointermove.
