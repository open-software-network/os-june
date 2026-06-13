import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

/** A textarea that starts at one line and grows with its content, the way
 * the chat composer does. CSS max-height caps the growth; past the cap the
 * field scrolls instead. */
export function GrowingTextarea(
  props: TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    // +2 covers the top/bottom border so the last line never clips into a
    // scrollbar flicker.
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [props.value]);

  return <textarea ref={ref} rows={1} {...props} />;
}
