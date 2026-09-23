// Lifecycle tests stub verification; credential conformance runs separately.
export function proof() { return {}; }
export function trust(client) {
  client.verifyDevice = async () => ({ kind: "hardware" });
  return client;
}
