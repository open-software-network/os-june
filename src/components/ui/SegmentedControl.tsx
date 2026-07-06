import { useLayoutEffect, useRef, useState } from "react";

type Option<T extends string> = {
  value: T;
  label: React.ReactNode;
  ariaLabel?: string;
};

type Props<T extends string> = {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly Option<T>[];
  className?: string;
  "aria-label"?: string;
};

/**
 * Animated segmented control. Each segment sizes to its own label and the
 * indicator measures the active button and matches its position + width.
 *
 * Ported from Fellow's `components/ui/segmented-control.tsx` so the two
 * apps share interaction language.
 */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  className,
  "aria-label": ariaLabel,
}: Props<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const [indicator, setIndicator] = useState<{
    left: number;
    width: number;
  } | null>(null);

  const selectedIndex = Math.max(
    0,
    options.findIndex((opt) => opt.value === value),
  );

  useLayoutEffect(() => {
    function measure() {
      const button = buttonsRef.current[selectedIndex];
      if (!containerRef.current || !button) return;
      // offsetLeft/offsetWidth, not getBoundingClientRect: rects include
      // ancestor transforms, so measuring while a parent's entrance
      // animation is mid-scale (e.g. the dialog card) bakes the shrunken
      // geometry into the indicator and nothing ever re-measures. Offsets
      // are layout-based and transform-immune; the container is the
      // positioned offsetParent.
      setIndicator({
        left: button.offsetLeft,
        width: button.offsetWidth,
      });
    }
    measure();
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [selectedIndex]);

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={ariaLabel}
      className={["segmented", className].filter(Boolean).join(" ")}
    >
      {indicator ? (
        <span
          aria-hidden
          className="segmented-indicator"
          style={{
            width: indicator.width,
            transform: `translateX(${indicator.left}px)`,
          }}
        />
      ) : null}
      {options.map((opt, idx) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              buttonsRef.current[idx] = el;
            }}
            type="button"
            aria-pressed={selected}
            aria-label={opt.ariaLabel}
            title={opt.ariaLabel}
            onClick={() => onValueChange(opt.value)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
