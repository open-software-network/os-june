import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconChevronRightSmall } from "central-icons/IconChevronRightSmall";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { type ReactNode, useState } from "react";
import { Switch } from "../../ui/Switch";
export function ManagementToolbar({
  loading,
  placeholder,
  query,
  onQueryChange,
  onRefresh,
}: {
  loading: boolean;
  placeholder: string;
  query: string;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
}) {
  const [refreshSpins, setRefreshSpins] = useState(0);
  return (
    <div className="agent-management-toolbar">
      <label className="agent-management-search">
        <IconMagnifyingGlass size={15} aria-hidden className="agent-management-search-icon" />
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder={placeholder}
          aria-label={placeholder}
        />
      </label>
      <button
        type="button"
        className="icon-button agent-management-refresh"
        aria-label="Refresh"
        aria-busy={loading}
        title="Refresh"
        disabled={loading}
        onClick={() => {
          setRefreshSpins((spins) => spins + 1);
          onRefresh();
        }}
      >
        <IconArrowRotateClockwise
          size={14}
          className="balance-refresh-icon"
          style={{ transform: `rotate(${refreshSpins * 360}deg)` }}
        />
      </button>
    </div>
  );
}

export function CapabilityGroup({
  children,
  count,
  empty,
  title,
  hideTitle = false,
}: {
  children: ReactNode;
  count: number;
  empty: string;
  title: string;
  /** Hides the in-list heading when the group's title lives above the card as
   * the group heading (the messaging platforms group). */
  hideTitle?: boolean;
}) {
  return (
    <section className="agent-capability-group">
      {hideTitle ? null : (
        <h3>
          {title} <span>{count}</span>
        </h3>
      )}
      {count ? children : <p className="agent-capability-empty">{empty}</p>}
    </section>
  );
}

export function CapabilityRow({
  children,
  count,
  description,
  enabled,
  meta,
  notConfigured = false,
  saving,
  selected = false,
  title,
  onSelect,
  onToggle,
}: {
  children?: ReactNode;
  /** A quiet count badge beside the name (e.g. "0/2" required fields set),
   * using the same muted number-badge treatment as the group count. */
  count?: string;
  description?: string;
  enabled: boolean;
  meta?: string;
  /** When true a quiet "Not configured" status pill sits to the left of the
   * switch, flagging that the platform still needs its credentials. */
  notConfigured?: boolean;
  saving: boolean;
  selected?: boolean;
  title: string;
  onSelect?: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <article className="agent-capability-row" data-selected={selected} data-clickable={!!onSelect}>
      <button type="button" disabled={!onSelect} onClick={onSelect}>
        <div className="agent-capability-title">
          <span>{title}</span>
          {count ? <span className="status-pill agent-capability-count">{count}</span> : null}
          {meta ? <em>{meta}</em> : null}
        </div>
        {description ? <p>{description}</p> : null}
        {children}
      </button>
      <div className="agent-capability-actions">
        {notConfigured ? (
          <span className="status-pill agent-capability-status">Not configured</span>
        ) : null}
        <Switch
          checked={enabled}
          disabled={saving}
          onCheckedChange={onToggle}
          aria-label={`${enabled ? "Disable" : "Enable"} ${title}`}
        />
        {onSelect ? (
          <IconChevronRightSmall size={14} aria-hidden className="agent-capability-chevron" />
        ) : null}
      </div>
    </article>
  );
}

// Sums turn/part counts plus streamed text lengths so the auto-scroll effect
// re-fires as streamed output grows, not only when a whole turn is added.
