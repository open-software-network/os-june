# Lessons

- When a user asks about modal/backdrop ordering, treat it as a stacking
  contract first. Do not hide chrome unless they explicitly ask for visibility
  changes; verify the intended z-index relationship instead.
- When fixing clipped chrome, preserve the requested alignment. Move the clip
  boundary or paint gutter instead of shifting the visible control.
- When a custom chrome layer sits above the base titlebar drag layer, empty
  space in that layer must forward pointerdown to the explicit native
  `startDragging()` path while child controls guard themselves by target.
- When a user says a spinner/name change happened elsewhere, honor the latest component name from main while preserving the intended behavior. In this session, the spinner behavior belongs in the trailing agent-session state slot, but the component is `DotSpinner`.
- During drag-preview UI states, avoid `display` toggles for reversible pointer gestures. Hide collapsed preview with visibility/pointer-events so reopening can render immediately while related fixed panels stay mounted.
- For tiny native HUDs, verify both the final steady state and the first visible frames after a hidden or interrupted show. A correct final size can still hitch if the native window animates from a stale frame while visible; fresh shows should be pre-sized while hidden, with animation reserved for visible state-to-state morphs.
- getBoundingClientRect includes CSS transforms, and a hidden WKWebView suspends its animation timeline. Any "measure the DOM to size a native window" path must neutralize in-flight transitions first (transition: none for one reflow), or a frozen exit transform (e.g. the HUD's scale 0.94) gets baked into the native frame and the window comes up clipped.
- When an overlay can be dragged around the screen, expansion direction must be
  position-aware. A one-sided reveal that looks clean at top-center can feel
  broken near screen edges; query native monitor/work-area context and reveal
  into available space.
- Do not swap a native HUD back to vibrancy while an oversized transitional
  window is still visible. Keep exit states on the same chrome as the visible
  state, then restore idle chrome only after the window is hidden.
- When a user says an error HUD should "just fade out", do not mirror the
  entrance animation on exit. Keep the expanded error mounted and fade the
  whole surface in place.
- When a HUD uses `data-state="exiting"`, preserve the outgoing visual state
  separately. Otherwise exit selectors can fall back to the default layout and
  briefly repaint controls from a different state during fade-out.
- For same-footprint HUD transitions, do not use the generic morph path. If
  the layout is deliberately size-compatible, snap the native size and swap
  content directly to avoid a perceptible flash.
- Do not drive "live" recording affordances directly from persisted note
  `processing_status`. A stale `recording` row can survive interruption; gate
  live dots and labels from the active recording note/session instead.
