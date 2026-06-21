// Strips out TLS/TCP connection spam from `curl -v` outputs.
// Retains > request headers, < response headers, and the response body.
// Drops lines starting with `* ` unless they contain useful error info.

const RE_CURL_NOISE = /^\*\s+(Trying|Connected|ALPN|CA cert|SSL connection|Server certificate|subjectAltName|issuer:|subject:|SSL|TLS|TCP|Hostname|Using HTTP)/i;

export function curlVerbose(text) {
  if (!text) return text;

  const lines = text.split("\n");
  const filtered = [];
  let strippedCount = 0;

  for (const line of lines) {
    if (RE_CURL_NOISE.test(line)) {
      strippedCount++;
    } else {
      filtered.push(line);
    }
  }

  if (strippedCount === 0) return text;

  // Add a note at the top if we stripped a lot of lines
  if (strippedCount > 10) {
    filtered.unshift(`[kRouter RTK: Stripped ${strippedCount} lines of curl TLS/TCP handshake noise]`);
  }

  return filtered.join("\n");
}
