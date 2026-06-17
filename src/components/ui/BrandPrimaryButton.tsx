import type { ReactNode } from "react";
import { BorderBeam } from "border-beam";

type Props = {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
};

export function BrandPrimaryButton({ children, disabled, onClick }: Props) {
  return (
    <BorderBeam
      active={!disabled}
      borderRadius={10}
      className="onboarding-primary-beam"
      colorVariant="sunset"
      duration={4.8}
      size="sm"
      staticColors
      strength={0.22}
      theme="light"
    >
      <button
        type="button"
        className="primary-action onboarding-continue"
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
    </BorderBeam>
  );
}
