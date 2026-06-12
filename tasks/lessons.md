# Lessons

- When a user says a spinner/name change happened elsewhere, honor the latest component name from main while preserving the intended behavior. In this session, the spinner behavior belongs in the trailing agent-session state slot, but the component is `DotSpinner`.
- During drag-preview UI states, avoid toggling `display: none` on elements that may re-open during the same pointer gesture. Keep the element mounted and animate or clip via layout state so reversing direction does not flash.
