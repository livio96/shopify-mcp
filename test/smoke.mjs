// Starts a mock Shopify + the MCP server, then exercises the tools through a real MCP client.
import http from "node:http";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

let tokenRequests = 0, throttleHits = 0, sawToken = [], sawIdem = [];
const MOCK_PORT = 4555, MCP_PORT = 4556;
const TOKEN = "t".repeat(40);

const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (o, code = 200, h = {}) => { res.writeHead(code, { "Content-Type": "application/json", ...h }); res.end(JSON.stringify(o)); };
    if (req.url === "/admin/oauth/access_token") { tokenRequests++; return send({ access_token: "shpat_mock_" + tokenRequests, scope: "write_orders", expires_in: 86399 }); }
    if (req.url === "/bulk.jsonl") { res.writeHead(200); return res.end('{"id":"gid://shopify/Product/1"}\n{"id":"gid://shopify/Product/2"}\n'); }
    sawToken.push(req.headers["x-shopify-access-token"]);
    if (req.url.startsWith("/admin/api/2026-10/shop.json")) return send({ shop: { name: "Mock" } });
    if (req.url === "/admin/api/2026-10/graphql.json") {
      const { query, variables } = JSON.parse(body);
      if (req.headers["idempotency-key"]) sawIdem.push(req.headers["idempotency-key"]);
      if (query.includes("currentAppInstallation")) return send({ data: { shop: { name: "Mock", myshopifyDomain: "mock.myshopify.com" }, currentAppInstallation: { app: { title: "A", handle: "a" }, accessScopes: [{ handle: "write_orders" }, { handle: "read_orders" }] } } });
      if (query.includes("throttleme")) { throttleHits++; if (throttleHits === 1) return send({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: { cost: { requestedQueryCost: 100, throttleStatus: { currentlyAvailable: 99, restoreRate: 1000 } } } }); return send({ data: { ok: true } }); }
      if (query.includes("__schema")) return send({ data: { __schema: { mutationType: { fields: [{ name: "orderCreate", description: "", isDeprecated: false, args: [{ name: "order" }, { name: "options" }], type: { kind: "OBJECT", name: "OrderCreatePayload" } }, { name: "companyCreate", description: "", isDeprecated: false, args: [{ name: "input" }], type: { kind: "OBJECT", name: "CompanyCreatePayload" } }] } } } });
      if (query.includes("__type")) return send({ data: { __type: { kind: "ENUM", name: variables.n, enumValues: [{ name: "A", isDeprecated: false }] } } });
      if (query.includes("customers(")) { const after = variables.after; if (!after) return send({ data: { customers: { nodes: [{ id: "1" }, { id: "2" }], pageInfo: { hasNextPage: true, endCursor: "c1" } } } }); return send({ data: { customers: { nodes: [{ id: "3" }], pageInfo: { hasNextPage: false, endCursor: null } } } }); }
      if (query.includes("bulkOperationRunQuery")) return send({ data: { bulkOperationRunQuery: { bulkOperation: { id: "gid://shopify/BulkOperation/9", status: "CREATED" }, userErrors: [] } } });
      if (query.includes("BulkOperation")) return send({ data: { node: { id: "gid://shopify/BulkOperation/9", status: "COMPLETED", objectCount: "2", url: `http://localhost:${MOCK_PORT}/bulk.jsonl` } } });
      if (query.includes("orderCreate")) return send({ data: { orderCreate: { order: { id: "gid://shopify/Order/1", name: "NS-1" }, userErrors: [] } } });
      return send({ data: { echo: true } });
    }
    send({ error: "not found" }, 404);
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!cond) failures++; };
const text = (r) => r.content?.[0]?.text ?? "";

await new Promise((r) => mock.listen(MOCK_PORT, r));
const child = spawn("node", ["src/server.js"], {
  env: { ...process.env, PORT: String(MCP_PORT), MCP_AUTH_TOKEN: TOKEN, SHOPIFY_SHOP: "mock", SHOPIFY_CLIENT_ID: "id", SHOPIFY_CLIENT_SECRET: "secret", SHOPIFY_ADMIN_BASE: `http://localhost:${MOCK_PORT}` },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = ""; child.stdout.on("data", (d) => (logs += d)); child.stderr.on("data", (d) => (logs += d));
await sleep(1200);

try {
  // auth
  const bad = await fetch(`http://localhost:${MCP_PORT}/mcp/wrongtoken`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" });
  check("wrong token is rejected (401)", bad.status === 401);
  const none = await fetch(`http://localhost:${MCP_PORT}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("no token is rejected (401)", none.status === 401);
  const health = await (await fetch(`http://localhost:${MCP_PORT}/healthz`)).json();
  check("healthz ok, no config problems", health.ok && health.configProblems.length === 0);

  const client = new Client({ name: "smoke", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${MCP_PORT}/mcp/${TOKEN}`)));
  const tools = (await client.listTools()).tools;
  check("10 tools listed", tools.length === 10, tools.map((t) => t.name).join(","));
  check("query tool is readOnly, mutation tool is not", tools.find((t) => t.name === "shopify_graphql_query").annotations.readOnlyHint === true && tools.find((t) => t.name === "shopify_graphql_mutation").annotations.readOnlyHint === false);

  let r = await client.callTool({ name: "shopify_shop_info", arguments: {} });
  check("shop_info returns scopes", text(r).includes("write_orders"));
  check("client-credentials token used", sawToken.every((t) => t === "shpat_mock_1") && tokenRequests === 1, `tokenRequests=${tokenRequests}`);

  r = await client.callTool({ name: "shopify_graphql_query", arguments: { query: "{ shop { name } }" } });
  check("query runs", text(r).includes("echo"));
  r = await client.callTool({ name: "shopify_graphql_query", arguments: { query: "mutation { orderCreate(order:{}) { order { id } } }" } });
  check("query tool refuses a mutation", r.isError === true);
  r = await client.callTool({ name: "shopify_graphql_query", arguments: { query: '{ shop { name } } # mutation in comment' } });
  check("'mutation' inside a comment is not misdetected", !r.isError);
  r = await client.callTool({ name: "shopify_graphql_mutation", arguments: { query: "{ shop { name } }" } });
  check("mutation tool refuses a query", r.isError === true);
  r = await client.callTool({ name: "shopify_graphql_mutation", arguments: { query: "mutation { orderCreate(order:{}) { order { id name } } }", idempotencyKey: "abc-1" } });
  check("mutation runs and passes idempotency key", text(r).includes("NS-1") && sawIdem.includes("abc-1"));

  r = await client.callTool({ name: "shopify_graphql_query", arguments: { query: "{ throttleme }" } });
  check("THROTTLED is retried transparently", text(r).includes('"ok": true') && throttleHits === 2, `hits=${throttleHits}`);

  r = await client.callTool({ name: "shopify_paginate", arguments: { query: "query($after:String){ customers(first:2, after:$after){ nodes{id} pageInfo{hasNextPage endCursor} } }", connectionPath: "customers", maxItems: 100 } });
  check("paginate follows cursors (3 items, 2 pages)", text(r).includes('"count": 3') && text(r).includes('"pages": 2'));

  r = await client.callTool({ name: "shopify_schema", arguments: { operation: "mutation", search: "order" } });
  check("schema search filters root fields", text(r).includes("orderCreate") && !text(r).includes("companyCreate"));
  r = await client.callTool({ name: "shopify_schema", arguments: { operation: "type", name: "OrderCreateFinancialStatus" } });
  check("schema type describe", text(r).includes("ENUM"));

  r = await client.callTool({ name: "shopify_rest", arguments: { path: "shop.json" } });
  check("REST passthrough", text(r).includes('"status": 200') && text(r).includes("Mock"));

  r = await client.callTool({ name: "shopify_bulk_query", arguments: { query: "{ products { edges { node { id } } } }", waitSeconds: 10, previewLines: 5 } });
  check("bulk query returns preview", text(r).includes('"totalLines": 2'));

  await client.close();

  // READ_ONLY mode
  const ro = spawn("node", ["src/server.js"], { env: { ...process.env, PORT: "4557", MCP_AUTH_TOKEN: TOKEN, SHOPIFY_SHOP: "mock", SHOPIFY_ACCESS_TOKEN: "shpat_static", READ_ONLY: "true", SHOPIFY_ADMIN_BASE: `http://localhost:${MOCK_PORT}` }, stdio: "ignore" });
  await sleep(1000);
  const c2 = new Client({ name: "ro", version: "1" });
  await c2.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:4557/mcp/${TOKEN}`)));
  r = await c2.callTool({ name: "shopify_graphql_mutation", arguments: { query: "mutation { orderCreate(order:{}) { order { id } } }" } });
  check("READ_ONLY blocks mutations", r.isError === true && text(r).includes("READ_ONLY"));
  r = await c2.callTool({ name: "shopify_rest", arguments: { method: "POST", path: "orders.json", body: {} } });
  check("READ_ONLY blocks REST writes", r.isError === true);
  r = await c2.callTool({ name: "shopify_graphql_query", arguments: { query: "{ shop { name } }" } });
  check("READ_ONLY still allows reads (static token)", text(r).includes("echo") && sawToken.includes("shpat_static"));
  await c2.close(); ro.kill();

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
} catch (e) {
  console.error("TEST ERROR", e); failures++;
} finally {
  const leaked = logs.includes(TOKEN);
  check("auth token never appears in server logs", !leaked);
  child.kill(); mock.close();
  process.exit(failures ? 1 : 0);
}
