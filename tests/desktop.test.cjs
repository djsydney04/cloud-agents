const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateEndpoint,
  validateRequest,
} = require("../desktop/connection.cjs");
test("remote connections require TLS and reject credential-bearing URLs", () => {
  for (const value of [
    "http://192.168.1.4:7420",
    "https://user:pass@host",
    "https://host/?token=secret",
    "file:///etc/passwd",
    "https://host/path",
  ])
    assert.throws(() => validateEndpoint(value));
  assert.equal(
    validateEndpoint("https://mini.example.ts.net"),
    "https://mini.example.ts.net",
  );
  assert.equal(
    validateEndpoint("http://127.0.0.1:7420"),
    "http://127.0.0.1:7420",
  );
});
test("renderer IPC accepts only the host API contract", () => {
  for (const path of [
    "//evil",
    "/jobs/../../secret",
    "/host?token=x",
    "/jobs/not-an-id",
  ])
    assert.throws(() => validateRequest({ path }));
  validateRequest({
    path: "/jobs/550e8400-e29b-41d4-a716-446655440000/cancel",
    method: "POST",
  });
  assert.throws(() => validateRequest({ path: "/host", method: "PATCH" }));
});
