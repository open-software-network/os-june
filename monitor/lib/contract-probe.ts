export function matchesContractResponse(
  statusCode: number,
  body: unknown,
  expectedStatusCode: number,
  expectedErrorCode?: number,
): boolean {
  if (statusCode !== expectedStatusCode) return false;
  if (expectedErrorCode === undefined) return true;
  if (!body || typeof body !== "object" || !("error_code" in body)) return false;
  return (body as { error_code?: unknown }).error_code === expectedErrorCode;
}
