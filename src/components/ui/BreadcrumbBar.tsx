import type { ReactNode } from "react";
import { BackButton } from "./BackButton";

type BreadcrumbItem = {
  label: string;
  onClick?: () => void;
};

type Props = {
  backLabel: string;
  onBack: () => void;
  items: BreadcrumbItem[];
  actions?: ReactNode;
};

export function BreadcrumbBar({ backLabel, onBack, items, actions }: Props) {
  return (
    <div className="detail-bar" data-tauri-drag-region>
      <BackButton label={backLabel} onClick={onBack} />
      <nav className="detail-breadcrumb" aria-label="Breadcrumb">
        <ol>
          {items.map((item, index) => {
            const current = index === items.length - 1;
            return (
              <li key={`${item.label}-${index}`}>
                {index > 0 ? (
                  <span className="detail-breadcrumb-separator" aria-hidden>
                    /
                  </span>
                ) : null}
                {item.onClick && !current ? (
                  <button
                    type="button"
                    className="detail-breadcrumb-link"
                    onClick={item.onClick}
                  >
                    {item.label}
                  </button>
                ) : (
                  <span
                    className={
                      current
                        ? "detail-breadcrumb-current"
                        : "detail-breadcrumb-label"
                    }
                  >
                    {item.label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      {actions ? <div className="detail-bar-actions">{actions}</div> : null}
    </div>
  );
}
