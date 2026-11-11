import crypto from "node:crypto";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as sp from "./shopify.js";

const PORT = Number(process.env.PORT || 3000);
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
const READ_ONLY = /^(1|true|yes)$/i.test(process.env.READ_ONLY || "");
const MAX_CHARS = Number(process.env.MAX_RESPONSE_CHARS || 80000);

if (MCP_AUTH_TOKEN.length < 24) {
  console.error("Refusing to start: MCP_AUTH_TOKEN must be set to a random string of at least 24 characters.");
  process.exit(1);
}
const cfgProblems = sp.configCheck();
if (cfgProblems.length) console.error("Shopify config problems:", cfgProblems.join("; "));

// ---------------- helpers ----------------
function out(value, { isError = false } = {}) {
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  if (text.length > MAX_CHARS) {
    text =
      text.slice(0, MAX_CHARS) +
      `\n\n[TRUNCATED: output was ${text.length} characters, limit ${MAX_CHARS}. Narrow the query (fewer fields, a search filter, a smaller page) or use shopify_bulk_query for large exports.]`;
  }
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}
const fail = (e) => out(`Error: ${e?.message || String(e)}`, { isError: true });
const blocked = (what) =>
  out(`Blocked: the server is running with READ_ONLY=true, so ${what} is disabled. Unset READ_ONLY on Render to allow writes.`, { isError: true });
const wrap = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    return fail(e);
  }
};
const gqlResult = (json) => out(json, { isError: !!(json.errors?.length && !json.data) });

const versionArg = z.string().regex(/^(\d{4}-\d{2}|unstable)$/).optional().describe("Override the Admin API version, e.g. 2025-07. Defaults to the server's configured version.");

// ---------------- MCP server ----------------
function buildServer() {
  const server = new McpServer({ name: "shopify-admin-mcp", version: "1.0.0" });

  server.registerTool(
    "shopify_graphql_query",
    {
      title: "Shopify GraphQL query (read)",
      description:
        "Run any read-only Shopify Admin GraphQL query. Use shopify_schema first if unsure of field names. Returns the full GraphQL response including `extensions.cost`. Max 100 items per connection page; for more, use shopify_paginate or shopify_bulk_query.",
      inputSchema: {
        query: z.string().min(1).describe("GraphQL query document"),
        variables: z.record(z.string(), z.any()).optional().describe("GraphQL variables"),
        apiVersion: versionArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async ({ query, variables, apiVersion }) => {
      if (sp.operationKind(query) !== "query") return out("This tool only runs queries. Use shopify_graphql_mutation for mutations.", { isError: true });
      return gqlResult(await sp.gql(query, variables || {}, { apiVersion }));
    }),
  );

  server.registerTool(
    "shopify_graphql_mutation",
    {
      title: "Shopify GraphQL mutation (write)",
      description:
        "Run any Shopify Admin GraphQL mutation (create/update/delete anything the app's access scopes allow, including orderCreate, companyCreate, metafieldsSet, etc.). ALWAYS inspect `userErrors` in the response. Pass `idempotencyKey` for create-type mutations that must not run twice if retried.",
      inputSchema: {
        query: z.string().min(1).describe("GraphQL mutation document"),
        variables: z.record(z.string(), z.any()).optional().describe("GraphQL variables"),
        idempotencyKey: z.string().max(100).optional().describe("Unique key to make a retry safe (Shopify Idempotency-Key header)"),
        apiVersion: versionArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    wrap(async ({ query, variables, idempotencyKey, apiVersion }) => {
      if (READ_ONLY) return blocked("mutations");
      if (sp.operationKind(query) !== "mutation") return out("This tool only runs mutations. Use shopify_graphql_query for queries.", { isError: true });
      return gqlResult(await sp.gql(query, variables || {}, { apiVersion, idempotencyKey }));
    }),
  );

  server.registerTool(
    "shopify_paginate",
    {
      title: "Shopify GraphQL auto-paginate (read)",
      description:
        "Run a read query repeatedly, following cursors, and return the combined list of nodes. The query MUST declare `$after: String`, pass `after: $after` to the connection, and select `pageInfo { hasNextPage endCursor }` plus `nodes { ... }` (or edges{node}). `connectionPath` is the dot path to the connection inside `data`, e.g. `customers` or `company.locations`.",
      inputSchema: {
        query: z.string().min(1),
        variables: z.record(z.string(), z.any()).optional(),
        connectionPath: z.string().min(1).describe("e.g. 'orders' or 'company.contacts'"),
        maxPages: z.number().int().min(1).max(100).default(10),
        maxItems: z.number().int().min(1).max(10000).default(500),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async ({ query, variables, connectionPath, maxPages, maxItems }) => {
      if (sp.operationKind(query) !== "query") return out("shopify_paginate only runs queries.", { isError: true });
      const r = await sp.paginate({ query, variables, connectionPath, maxPages, maxItems });
      return out({ count: r.items.length, pages: r.pages, truncated: r.truncated, errors: r.errors, items: r.items });
    }),
  );

  server.registerTool(
    "shopify_schema",
    {
      title: "Explore the Shopify Admin GraphQL schema",
      description:
        "Introspect the live Admin schema. Modes: (1) operation='query'|'mutation' with optional `search` lists root field names; (2) operation='query'|'mutation' with `name` describes that root field (args and return type); (3) operation='type' with `name` describes an object/input/enum/union type.",
      inputSchema: {
        operation: z.enum(["query", "mutation", "type"]),
        search: z.string().optional().describe("Substring filter for root field names"),
        name: z.string().optional().describe("Root field name, or type name when operation='type'"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async ({ operation, search, name }) => {
      if (operation === "type") {
        if (!name) return out("Provide `name` (the type name).", { isError: true });
        const t = await sp.schemaDescribeType(name);
        return t ? out(t) : out(`No type named ${name}.`, { isError: true });
      }
      if (name) {
        const f = await sp.schemaDescribeRootField(operation, name);
        return f ? out(f) : out(`No ${operation} field named ${name}.`, { isError: true });
      }
      return out(await sp.schemaRootFields(operation, search));
    }),
  );

  server.registerTool(
    "shopify_rest",
    {
      title: "Shopify Admin REST passthrough",
      description:
        "Call any Shopify Admin REST endpoint. `path` is relative to /admin/api/{version}/ (e.g. 'orders/123.json') or an absolute path starting with /admin/. REST is legacy for many resources, so prefer GraphQL; use this only where REST still has something GraphQL lacks. Non-GET calls are blocked when READ_ONLY=true.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"),
        path: z.string().min(1),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z.any().optional().describe("JSON body for POST/PUT"),
        apiVersion: versionArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    wrap(async ({ method, path, query, body, apiVersion }) => {
      if (READ_ONLY && method !== "GET") return blocked("non-GET REST calls");
      return out(await sp.rest({ method, path, query, body, apiVersion }));
    }),
  );

  server.registerTool(
    "shopify_bulk_query",
    {
      title: "Shopify bulk query (large read exports)",
      description:
        "Start a Shopify bulk operation query (no pagination or rate-limit cost, ideal for tens of thousands of records), wait for it, and return a bounded preview of the JSONL result plus the download URL. Only one bulk query can run per shop at a time. If it has not finished within waitSeconds, use shopify_bulk_status with the returned id.",
      inputSchema: {
        query: z.string().min(1).describe("The inner query, e.g. '{ products { edges { node { id title } } } }'"),
        waitSeconds: z.number().int().min(0).max(110).default(45),
        previewLines: z.number().int().min(0).max(500).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async ({ query, waitSeconds, previewLines }) => {
      const r = await sp.bulkRun({ kind: "query", query, waitSeconds });
      if (!r.started) return out(r, { isError: true });
      const res = { id: r.id, finished: r.finished, operation: r.operation };
      if (r.finished && r.operation?.status === "COMPLETED" && r.operation.url && previewLines > 0) {
        res.preview = await sp.bulkResult(r.operation.url, { maxLines: previewLines });
      }
      return out(res);
    }),
  );

  server.registerTool(
    "shopify_bulk_status",
    {
      title: "Shopify bulk operation status / result",
      description:
        "Check a bulk operation (or the current one if no id). With fetchPreview=true and a COMPLETED operation, also returns the first lines of the JSONL result. The `url` in the response is a temporary download link for the full file.",
      inputSchema: {
        id: z.string().optional().describe("gid://shopify/BulkOperation/..."),
        fetchPreview: z.boolean().default(false),
        previewLines: z.number().int().min(1).max(500).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async ({ id, fetchPreview, previewLines }) => {
      const op = await sp.bulkStatus(id);
      if (!op) return out("No bulk operation found.");
      const res = { operation: op };
      if (fetchPreview && op.status === "COMPLETED" && op.url) res.preview = await sp.bulkResult(op.url, { maxLines: previewLines });
      return out(res);
    }),
  );

  server.registerTool(
    "shopify_bulk_mutation",
    {
      title: "Shopify bulk mutation (large writes)",
      description:
        "Run one mutation many times via bulkOperationRunMutation. Provide the mutation document (with $variables) and `variablesJsonl`: one JSON object of variables per line. The server stages the JSONL upload for you, starts the job, and waits. Use for imports of hundreds or thousands of records. Shopify only allows certain mutations in bulk operations (see Shopify's docs for the supported list), so if it fails to start, run the mutation individually with shopify_graphql_mutation. Check the result URL for per-line errors.",
      inputSchema: {
        mutation: z.string().min(1).describe("e.g. 'mutation call($input: CustomerInput!) { customerCreate(input: $input) { customer { id } userErrors { field message } } }'"),
        variablesJsonl: z.string().min(2).describe('Lines like {"input":{"email":"a@b.com"}}'),
        waitSeconds: z.number().int().min(0).max(110).default(45),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    wrap(async ({ mutation, variablesJsonl, waitSeconds }) => {
      if (READ_ONLY) return blocked("bulk mutations");
      const up = await sp.bulkMutationUpload(variablesJsonl);
      if (!up.stagedUploadPath) return out({ step: "stage upload", detail: up }, { isError: true });
      const r = await sp.bulkRun({ kind: "mutation", mutation, stagedUploadPath: up.stagedUploadPath, waitSeconds });
      return out(r, { isError: !r.started });
    }),
  );

  server.registerTool(
    "shopify_upload_file",
    {
      title: "Upload a file to Shopify Files",
      description:
        "Upload a file (from a public URL or base64) to Shopify via staged upload and register it with fileCreate. Returns the staged resourceUrl and the created File id.",
      inputSchema: {
        url: z.string().url().optional().describe("Public source URL to download from"),
        contentBase64: z.string().optional().describe("File bytes as base64 (use for small files)"),
        filename: z.string().min(1),
        mimeType: z.string().optional(),
        resource: z.enum(["FILE", "IMAGE", "VIDEO", "MODEL_3D"]).default("FILE"),
        createFile: z.boolean().default(true),
        alt: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    wrap(async (args) => {
      if (READ_ONLY) return blocked("file uploads");
      return out(await sp.uploadFile(args));
    }),
  );

  server.registerTool(
    "shopify_shop_info",
    {
      title: "Shop info and granted access scopes",
      description:
        "Return basic shop details, the API version in use, and the access scopes granted to this app. Run this first when a call fails with 'access denied' to see which scope is missing.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async () => {
      const j = await sp.gql(
        `{ shop { name myshopifyDomain primaryDomain { url } currencyCode plan { displayName shopifyPlus } }
           currentAppInstallation { app { title handle } accessScopes { handle } } }`,
      );
      return out({
        apiVersion: sp.API_VERSION,
        readOnlyMode: READ_ONLY,
        shop: j.data?.shop,
        app: j.data?.currentAppInstallation?.app,
        accessScopes: j.data?.currentAppInstallation?.accessScopes?.map((s) => s.handle),
        errors: j.errors,
      });
    }),
  );

  return server;
}

// ---------------- HTTP ----------------
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "20mb" }));

const sha = (s) => crypto.createHash("sha256").update(s).digest();
const expected = sha(MCP_AUTH_TOKEN);
const fails = new Map(); // ip -> {count, reset}

function auth(req, res, next) {
  const ip = req.ip;
  const f = fails.get(ip);
  if (f && f.count >= 20 && Date.now() < f.reset) return res.status(429).json({ error: "Too many failed attempts" });

  let supplied = "";
  const h = req.headers.authorization || "";
  if (/^bearer /i.test(h)) supplied = h.slice(7).trim();
  else if (req.params.token) supplied = req.params.token;
  else if (typeof req.query.key === "string") supplied = req.query.key;

  const ok = supplied && crypto.timingSafeEqual(sha(supplied), expected);
  if (!ok) {
    const cur = f && Date.now() < f.reset ? f : { count: 0, reset: Date.now() + 60_000 };
    cur.count++;
    fails.set(ip, cur);
    return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  }
  next();
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, shop: sp.SHOP || null, apiVersion: sp.API_VERSION, readOnly: READ_ONLY, configProblems: sp.configCheck() });
});

async function handleMcp(req, res) {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("MCP request error:", e?.message);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
}
const methodNotAllowed = (_req, res) =>
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: use POST)" }, id: null });

app.post(["/mcp", "/mcp/:token"], auth, handleMcp);
app.get(["/mcp", "/mcp/:token"], auth, methodNotAllowed);
app.delete(["/mcp", "/mcp/:token"], auth, methodNotAllowed);

app.listen(PORT, "0.0.0.0", () => {
  // Never log the request path: it may contain the secret token.
  console.log(`shopify-admin-mcp listening on :${PORT} shop=${sp.SHOP || "(unset)"} api=${sp.API_VERSION} readOnly=${READ_ONLY}`);
});
