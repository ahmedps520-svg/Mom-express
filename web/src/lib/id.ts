/**
 * A random id for a new request. Sent with the request so that resending it
 * (after a double tap or a dropped connection) never creates a duplicate.
 * Uses getRandomValues, which also works on plain-HTTP home networks.
 */
export function newClientRequestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
