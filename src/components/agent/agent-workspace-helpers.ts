import type {
  HermesMessagingPlatformInfo,
  HermesSkillInfo,
  HermesToolsetInfo,
} from "../../lib/tauri";

export function safeText(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function capabilityMatches(
  item: HermesSkillInfo | HermesToolsetInfo | HermesMessagingPlatformInfo,
  query: string,
) {
  if (!query) return true;
  const values = [
    "name" in item ? item.name : "",
    "label" in item ? item.label : "",
    "description" in item ? item.description : "",
    "category" in item ? item.category : "",
    "provider" in item ? item.provider : "",
    "state" in item ? item.state : "",
  ];
  if ("tools" in item && Array.isArray(item.tools)) {
    values.push(...item.tools);
  }
  return values.some((value) => safeText(value).toLowerCase().includes(query));
}
