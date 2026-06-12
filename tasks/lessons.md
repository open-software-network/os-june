# Lessons

- When a user says a spinner/name change happened elsewhere, honor the latest component name from main while preserving the intended behavior. In this session, the spinner behavior belongs in the trailing agent-session state slot, but the component is `DotSpinner`.
- During drag-preview UI states, avoid `display` toggles for reversible pointer gestures. Hide collapsed preview with visibility/pointer-events so reopening can render immediately while related fixed panels stay mounted.
