# Onward — Friction Log

## 1. Silent errors from the MCP SDK

**Task attempted:** Reuse a single `Server` instance across multiple MCP requests for performance.

**Steps taken:** Moved `Server` construction to module scope, kept a fresh `StreamableHTTPServerTransport` per request inside the HTTP handler.

**Expected result:** Request two behaves like request one.

**Actual result:** Request two returned HTTP 500, and the server terminal showed nothing. The SDK returned the failure as a JSON-RPC error object without logging.

**Severity:** High — silent failure, no diagnostics.

**Workaround:** Construct a fresh `Server` per request alongside the transport.

**Actionable suggestion:** The SDK could detect or warn when a `Server` is connected to multiple transports. The pairing is one-to-one but the docs don't say so.

## 2. Undocumented response format option

**Task attempted:** Connect a browser client to the MCP server over Streamable HTTP.

**Steps taken:** POST to `/mcp` with `Content-Type: application/json` and `Accept: application/json, text/event-stream`.

**Expected result:** A plain JSON-RPC response body.

**Actual result:** Worked, but only after discovering that `enableJsonResponse: true` changes the transport's response format from an event stream to plain JSON. This isn't obvious from the API surface.

**Severity:** Medium.

**Workaround:** Read the SDK source to confirm the option's behavior.

**Actionable suggestion:** Document the effect of `enableJsonResponse` on the response body format.

## 3. Unlogged tool-call errors

**Task attempted:** Debug a tool handler returning an error to the client.

**Steps taken:** Browser console showed HTTP 500. Server terminal showed nothing. Added a manual `console.error` inside the `CallToolRequestSchema` handler to surface the error.

**Expected result:** The SDK would log the underlying error server-side.

**Actual result:** It returned the error as JSON-RPC and continued silently.

**Severity:** Medium.

**Workaround:** Wrap every tool handler in try/catch and log explicitly.

**Actionable suggestion:** Log JSON-RPC error responses on the server by default, or provide an opt-in verbose mode.
