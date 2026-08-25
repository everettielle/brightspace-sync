export function normalizeBrightspaceOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Brightspace base URL must use HTTPS");
  if (url.username || url.password) {
    throw new Error("Brightspace base URL must not contain a username or password");
  }
  if (url.search || url.hash) {
    throw new Error("Brightspace base URL must not contain a query string or fragment");
  }
  return url.origin;
}
