import type { ReactNode } from "react";

type Props = {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
};

export function BrandPrimaryButton({ children, disabled, onClick }: Props) {
  return (
    <button
      type="button"
      className="primary-action primary-solid onboarding-continue"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
