function validateEndpoint(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Use a host origin without credentials, path, or query.");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error(
      "Remote hosts require HTTPS. Use localhost for SSH forwarding.",
    );
  return url.origin;
}
function validateRequest({ path, method = "GET" }) {
  if (
    !["GET", "POST", "DELETE"].includes(method) ||
    !/^\/(host|jobs(?:\/[a-f0-9-]{36}(?:\/(?:cancel|logs))?)?)$/.test(path)
  )
    throw new Error("Unsupported request.");
}
module.exports = { validateEndpoint, validateRequest };
