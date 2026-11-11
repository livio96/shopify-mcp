// Shopify Admin API client: token handling, GraphQL (with throttle retry), REST, pagination, bulk ops.

const SHOP_RAW = process.env.SHOPIFY_SHOP || "";
export const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-10";
const STATIC_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || "";
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || "";
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || "";

// SHOPIFY_SHOP may be "athq", "athq.myshopify.com" or a full https URL.
function normalizeShop(s) {
  let v = s.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (v && !v.includes(".")) v = `${v}.myshopify.com`;
  return v;
}
export const SHOP = normalizeShop(SHOP_RAW);
// Override only for tests (mock server).
const BASE = (process.env.SHOPIFY_ADMIN_BASE || `https://${SHOP}`).replace(/\/$/, "");

export function configCheck() {
  const problems = [];
  if (!SHOP) problems.push("SHOPIFY_SHOP is not set");
  if (!STATIC_TOKEN && !(CLIENT_ID && CLIENT_SECRET)) {
    problems.push("Set SHOPIFY_ACCESS_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET");
  }
  return problems;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- token ----------
let cached = { token: "", expiresAt: 0 };
let inflight = null;

async function fetchClientCredentialsToken() {
  const res = await fetch(`${BASE}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token request failed (${res.status}): ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  if (!j.access_token) throw new Error("Token response had no access_token");
  const ttl = Number(j.expires_in || 86399);
  cached = { token: j.access_token, expiresAt: Date.now() + (ttl - 120) * 1000 };
  return cached.token;
}

export async function getToken(forceRefresh = false) {
  if (STATIC_TOKEN) return STATIC_TOKEN;
  if (!forceRefresh && cached.token && Date.now() < cached.expiresAt) return cached.token;
  if (!inflight) inflight = fetchClientCredentialsToken().finally(() => (inflight = null));
  return inflight;
}

async function shopifyFetch(url, init = {}, attempt = 0) {
  const token = await getToken();
  const res = await fetch(url, {
    ...init,
    headers: { "X-Shopify-Access-Token": token, ...(init.headers || {}) },
  });
  // Token expired / revoked while using client credentials: refresh once.
  if (res.status === 401 && !STATIC_TOKEN && attempt === 0) {
    await getToken(true);
    return shopifyFetch(url, init, 1);
  }
  if ((res.status === 429 || res.status >= 502) && attempt < 5) {
    const ra = Number(res.headers.get("retry-after"));
    await sleep((Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt));
    return shopifyFetch(url, init, attempt + 1);
  }
  return res;
}

// ---------- GraphQL ----------
export async function gql(query, variables = {}, opts = {}) {
  const version = opts.apiVersion || API_VERSION;
  const url = `${BASE}/admin/api/${version}/graphql.json`;
  const extraHeaders = {};
  if (opts.idempotencyKey) extraHeaders["Idempotency-Key"] = opts.idempotencyKey;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await shopifyFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Shopify returned non-JSON (${res.status}): ${text.slice(0, 500)}`);
    }
    const throttled = (json.errors || []).some((e) => e?.extensions?.code === "THROTTLED");
    if (throttled && attempt < 5) {
      const ts = json.extensions?.cost?.throttleStatus;
      const requested = json.extensions?.cost?.requestedQueryCost ?? 100;
      let wait = 1500;
      if (ts?.restoreRate) {
        const missing = Math.max(0, requested - (ts.currentlyAvailable ?? 0));
        wait = Math.ceil((missing / ts.restoreRate) * 1000) + 250;
      }
      await sleep(Math.min(wait, 15000));
      continue;
    }
    if (!res.ok && !json.errors && !json.data) {
      throw new Error(`Shopify HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    return json;
  }
  throw new Error("Shopify GraphQL still throttled after retries");
}

export function operationKind(query) {
  // Strip comments and strings so keywords inside them don't confuse us.
  const clean = query
    .replace(/#[^\n\r]*/g, "")
    .replace(/"""[\s\S]*?"""/g, "")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
  const kinds = new Set();
  const re = /(^|[\s}])(query|mutation|subscription)\b/g;
  let m;
  while ((m = re.exec(clean))) kinds.add(m[2]);
  if (kinds.has("mutation")) return "mutation";
  if (kinds.has("subscription")) return "subscription";
  return "query"; // anonymous `{ ... }` shorthand is a query
}

// ---------- REST ----------
export async function rest({ method = "GET", path, query, body, apiVersion }) {
  let p = path.trim();
  if (!p.startsWith("/")) p = `/${p}`;
  if (!p.startsWith("/admin/")) p = `/admin/api/${apiVersion || API_VERSION}${p}`;
  const url = new URL(`${BASE}${p}`);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
  const init = { method, headers: { Accept: "application/json" } };
  if (body !== undefined && method !== "GET" && method !== "DELETE") {
    init.headers["Content-Type"] = "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await shopifyFetch(url.toString(), init);
  const text = await res.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { status: res.status, ok: res.ok, link: res.headers.get("link"), body: parsed };
}

// ---------- pagination ----------
function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

// The query must declare `$after: String` and pass it as `after:` on the connection,
// and select `pageInfo { hasNextPage endCursor }`.
export async function paginate({ query, variables = {}, connectionPath, maxPages = 10, maxItems = 1000 }) {
  const items = [];
  let after = null;
  let pages = 0;
  let truncated = false;
  let cost = null;
  while (pages < maxPages) {
    const json = await gql(query, { ...variables, after });
    if (json.errors?.length && !json.data) return { errors: json.errors, items, pages };
    const conn = getPath(json.data, connectionPath);
    if (!conn) return { errors: json.errors || [{ message: `No connection at path "${connectionPath}"` }], items, pages };
    const nodes = conn.nodes ?? (conn.edges || []).map((e) => e.node);
    items.push(...nodes);
    cost = json.extensions?.cost ?? cost;
    pages++;
    if (items.length >= maxItems) {
      items.length = maxItems;
      truncated = !!conn.pageInfo?.hasNextPage || nodes.length > 0;
      break;
    }
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
    if (pages >= maxPages) truncated = true;
  }
  return { items, pages, truncated, cost };
}

// ---------- bulk operations ----------
export async function bulkRun({ kind, query, mutation, stagedUploadPath, waitSeconds = 120 }) {
  let start;
  if (kind === "query") {
    start = await gql(
      `mutation($q: String!) { bulkOperationRunQuery(query: $q) { bulkOperation { id status } userErrors { field message code } } }`,
      { q: query },
    );
    start = start.data?.bulkOperationRunQuery ?? start;
  } else {
    start = await gql(
      `mutation($m: String!, $p: String!) { bulkOperationRunMutation(mutation: $m, stagedUploadPath: $p) { bulkOperation { id status } userErrors { field message code } } }`,
      { m: mutation, p: stagedUploadPath },
    );
    start = start.data?.bulkOperationRunMutation ?? start;
  }
  if (start.userErrors?.length || !start.bulkOperation?.id) return { started: false, detail: start };
  const id = start.bulkOperation.id;
  return { started: true, id, ...(await bulkWait(id, waitSeconds)) };
}

export async function bulkStatus(id) {
  const q = id
    ? `query($id: ID!) { node(id: $id) { ... on BulkOperation { id status errorCode createdAt completedAt objectCount rootObjectCount fileSize url partialDataUrl type } } }`
    : `query { currentBulkOperation { id status errorCode createdAt completedAt objectCount rootObjectCount fileSize url partialDataUrl type } }`;
  const j = await gql(q, id ? { id } : {});
  return id ? j.data?.node : j.data?.currentBulkOperation;
}

export async function bulkWait(id, waitSeconds = 120) {
  const deadline = Date.now() + waitSeconds * 1000;
  let op = await bulkStatus(id);
  while (op && ["CREATED", "RUNNING", "CANCELING"].includes(op.status) && Date.now() < deadline) {
    await sleep(3000);
    op = await bulkStatus(id);
  }
  return { operation: op, finished: op ? !["CREATED", "RUNNING", "CANCELING"].includes(op.status) : false };
}

// Download a bulk result (JSONL) and return a bounded preview.
export async function bulkResult(url, { maxLines = 50, maxChars = 60000 } = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Result download failed (${res.status})`);
  const text = await res.text();
  const lines = text.split("\n").filter(Boolean);
  let out = [];
  let chars = 0;
  for (const l of lines.slice(0, maxLines)) {
    if (chars + l.length > maxChars) break;
    out.push(l);
    chars += l.length;
  }
  return { totalLines: lines.length, returnedLines: out.length, jsonl: out.join("\n") };
}

// ---------- schema exploration (introspection) ----------
const TYPE_REF = `kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }`;

function typeStr(t) {
  if (!t) return "";
  if (t.kind === "NON_NULL") return `${typeStr(t.ofType)}!`;
  if (t.kind === "LIST") return `[${typeStr(t.ofType)}]`;
  return t.name;
}

export async function schemaRootFields(operation, search) {
  const root = operation === "mutation" ? "mutationType" : "queryType";
  const j = await gql(`{ __schema { ${root} { fields { name description isDeprecated args { name } } } } }`);
  let fields = j.data?.__schema?.[root]?.fields || [];
  if (search) {
    const s = search.toLowerCase();
    fields = fields.filter((f) => f.name.toLowerCase().includes(s));
  }
  return fields.map((f) => `${f.name}${f.isDeprecated ? " (deprecated)" : ""}(${f.args.map((a) => a.name).join(", ")})`);
}

export async function schemaDescribeRootField(operation, fieldName) {
  const root = operation === "mutation" ? "mutationType" : "queryType";
  const j = await gql(
    `{ __schema { ${root} { fields { name description isDeprecated args { name description type { ${TYPE_REF} } defaultValue } type { ${TYPE_REF} } } } } }`,
  );
  const f = (j.data?.__schema?.[root]?.fields || []).find((x) => x.name === fieldName);
  if (!f) return null;
  return {
    name: f.name,
    description: f.description,
    deprecated: f.isDeprecated,
    returns: typeStr(f.type),
    args: f.args.map((a) => `${a.name}: ${typeStr(a.type)}${a.defaultValue != null ? ` = ${a.defaultValue}` : ""}${a.description ? ` — ${a.description.split("\n")[0]}` : ""}`),
  };
}

export async function schemaDescribeType(name) {
  const j = await gql(
    `query($n: String!) { __type(name: $n) {
      kind name description
      fields(includeDeprecated: true) { name description isDeprecated args { name type { ${TYPE_REF} } } type { ${TYPE_REF} } }
      inputFields { name description type { ${TYPE_REF} } defaultValue }
      enumValues(includeDeprecated: true) { name description isDeprecated }
      possibleTypes { name }
      interfaces { name }
    } }`,
    { n: name },
  );
  const t = j.data?.__type;
  if (!t) return null;
  return {
    kind: t.kind,
    name: t.name,
    description: t.description?.split("\n")[0],
    implements: t.interfaces?.map((i) => i.name),
    possibleTypes: t.possibleTypes?.map((p) => p.name),
    fields: t.fields?.map(
      (f) => `${f.name}${f.args?.length ? `(${f.args.map((a) => `${a.name}: ${typeStr(a.type)}`).join(", ")})` : ""}: ${typeStr(f.type)}${f.isDeprecated ? " [deprecated]" : ""}`,
    ),
    inputFields: t.inputFields?.map((f) => `${f.name}: ${typeStr(f.type)}${f.defaultValue != null ? ` = ${f.defaultValue}` : ""}`),
    enumValues: t.enumValues?.map((e) => `${e.name}${e.isDeprecated ? " [deprecated]" : ""}`),
  };
}

// ---------- file upload (staged upload -> fileCreate) ----------
export async function uploadFile({ url, contentBase64, filename, mimeType, resource = "FILE", createFile = true, alt }) {
  let bytes;
  if (contentBase64) bytes = Buffer.from(contentBase64, "base64");
  else if (url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Could not download source (${r.status})`);
    bytes = Buffer.from(await r.arrayBuffer());
    mimeType = mimeType || r.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
  } else throw new Error("Provide url or contentBase64");
  mimeType = mimeType || "application/octet-stream";

  const staged = await gql(
    `mutation($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) {
       stagedTargets { url resourceUrl parameters { name value } }
       userErrors { field message } } }`,
    { input: [{ filename, mimeType, resource, httpMethod: "POST", fileSize: String(bytes.length) }] },
  );
  const payload = staged.data?.stagedUploadsCreate;
  if (!payload || payload.userErrors?.length || !payload.stagedTargets?.[0]) return { step: "stagedUploadsCreate", detail: staged };
  const target = payload.stagedTargets[0];

  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append("file", new Blob([bytes], { type: mimeType }), filename);
  const up = await fetch(target.url, { method: "POST", body: form });
  if (!up.ok) return { step: "upload", status: up.status, detail: (await up.text()).slice(0, 500) };

  const result = { uploaded: true, resourceUrl: target.resourceUrl, bytes: bytes.length };
  if (!createFile) return result;
  const contentType = mimeType.startsWith("image/") ? "IMAGE" : mimeType.startsWith("video/") ? "VIDEO" : mimeType.startsWith("model/") ? "MODEL_3D" : "FILE";
  const created = await gql(
    `mutation($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id fileStatus alt } userErrors { field message code } } }`,
    { files: [{ originalSource: target.resourceUrl, contentType, alt: alt || filename, filename }] },
  );
  return { ...result, fileCreate: created.data?.fileCreate ?? created };
}

// ---------- bulk mutation variables upload ----------
export async function bulkMutationUpload(jsonl) {
  const staged = await gql(
    `mutation($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) {
       stagedTargets { url resourceUrl parameters { name value } }
       userErrors { field message } } }`,
    { input: [{ resource: "BULK_MUTATION_VARIABLES", filename: "bulk_op_vars", mimeType: "text/jsonl", httpMethod: "POST" }] },
  );
  const payload = staged.data?.stagedUploadsCreate;
  if (!payload || payload.userErrors?.length || !payload.stagedTargets?.[0]) return { detail: staged };
  const target = payload.stagedTargets[0];
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append("file", new Blob([jsonl.endsWith("\n") ? jsonl : jsonl + "\n"], { type: "text/jsonl" }), "bulk_op_vars");
  const up = await fetch(target.url, { method: "POST", body: form });
  if (!up.ok) return { detail: { uploadStatus: up.status, body: (await up.text()).slice(0, 500) } };
  const key = target.parameters.find((p) => p.name === "key")?.value;
  return { stagedUploadPath: key };
}
