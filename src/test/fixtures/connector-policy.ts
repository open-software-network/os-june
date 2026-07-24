import type { ConnectorPolicyCatalog } from "../../lib/tauri";
import connectorPolicySnapshot from "./connector-policy.json";

const REPRESENTATIVE_CONNECTOR_POLICY =
  connectorPolicySnapshot as unknown as ConnectorPolicyCatalog;

/**
 * A mutable copy of the committed native catalog snapshot. Rust asserts that
 * `catalog()` serializes to the same JSON, so frontend policy tests cannot
 * silently drift from the native authority.
 */
export function representativeConnectorPolicy(): ConnectorPolicyCatalog {
  return structuredClone(REPRESENTATIVE_CONNECTOR_POLICY);
}
