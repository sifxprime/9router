const http = require("http");

const origCreate = http.createServer.bind(http);

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const wrapped = (req, res) => {
    const ip = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    // Forwarding headers present = request arrived via a reverse proxy
    // (Cloudflare, nginx, Caddy, Tailscale Funnel, etc.). The loopback socket
    // is then the proxy hop, NOT the end-user, so downstream must not treat
    // this connection as "local" (which would bypass our rate limiter and
    // grant API-key-less access to /v1 endpoints).
    const viaProxy = !!(req.headers["x-forwarded-for"] || req.headers["x-real-ip"]);
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    req.headers["x-9r-real-ip"] = ip;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
    return handler(req, res);
  };
  return origCreate(...rest, wrapped);
};

require("./server.js");
