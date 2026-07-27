export function agentComposerClearance(scrollerBottom: number, composerTop: number): number {
  return Math.max(0, Math.ceil(scrollerBottom - composerTop));
}
