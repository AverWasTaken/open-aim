// Checks for the local game server (main.js) and the IPC handlers: which URLs, hosts and
// pages count as the game's own, and URL paths turned into files that can never leave
// the folder they are served from.
const path = require("path");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

// A game page or request: localhost or 127.0.0.1 on the server's port.
function isLocalUrl(url, port) {
  try {
    const u = new URL(url);
    return LOCAL_HOSTS.has(u.hostname) && Number(u.port) === port;
  } catch {
    return false;
  }
}

// The Host header of a request to the local server. Anything else (a web page using DNS
// rebinding to reach 127.0.0.1) is refused.
function isLocalHost(host, port) {
  return typeof host === "string" && [...LOCAL_HOSTS].some((name) => host.toLowerCase() === `${name}:${port}`);
}

// An IPC call made by a game page (lobby or Studio, any frame of it), not by some other
// page or a frame that has already gone away.
function fromLocalPage(event, port) {
  const url = event && event.senderFrame && event.senderFrame.url;
  if (!url) return false;
  try {
    return new URL(url).protocol === "http:" && isLocalUrl(url, port);
  } catch {
    return false;
  }
}

// The file for an already decoded URL path inside `base`, or null when the path could
// point outside it: "..", backslashes, drive letters (":") and NUL are refused, and the
// joined path is checked to still be inside `base`. An empty path gives `base` itself.
function safeJoin(base, urlPath) {
  const parts = String(urlPath).split("/").filter((x) => x !== "" && x !== ".");
  if (parts.some((x) => x === ".." || /[\\:\0]/.test(x))) return null;
  const root = path.resolve(base);
  const full = path.resolve(root, ...parts);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

module.exports = { isLocalUrl, isLocalHost, fromLocalPage, safeJoin };
