// Test-copy settings from the environment (AIM_PORT, AIM_PROFILE, AIM_HEADLESS), checked
// before anything starts. A bad value stops the app with a message instead of quietly
// falling back to port 8000, the real app's port.
const DEFAULT_PORT = 8000;

// "" or unset: the default port. Anything else must be a whole number 1-65535.
function parsePort(raw) {
  const text = raw == null ? "" : String(raw).trim();
  if (text === "") return { port: DEFAULT_PORT, explicit: false };
  if (!/^\d+$/.test(text)) return { error: `AIM_PORT must be a port number (1-65535), got "${raw}"` };
  const port = Number(text);
  if (port < 1 || port > 65535) return { error: `AIM_PORT must be a port number (1-65535), got "${raw}"` };
  return { port, explicit: true };
}

// { port, headless } or { error }. A headless test copy must name its own port and profile,
// so it can never run on the real app's port or save.
function readTestEnv(env) {
  const headless = env.AIM_HEADLESS === "1";
  const parsed = parsePort(env.AIM_PORT);
  if (parsed.error) return { error: parsed.error, headless };
  if (headless) {
    if (!parsed.explicit) return { error: "AIM_HEADLESS=1 needs AIM_PORT (a test port, never 8000)", headless };
    if (parsed.port === DEFAULT_PORT) return { error: "AIM_HEADLESS=1 can't use port 8000 (the real app's port)", headless };
    if (!env.AIM_PROFILE || !String(env.AIM_PROFILE).trim()) return { error: "AIM_HEADLESS=1 needs AIM_PROFILE (a test data folder)", headless };
  }
  return { port: parsed.port, headless };
}

module.exports = { parsePort, readTestEnv, DEFAULT_PORT };
