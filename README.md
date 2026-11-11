# Shopify Admin MCP server

A remote MCP server that gives Claude full access to the Shopify Admin API (GraphQL and REST), limited only by the scopes granted to your app. Host it on Render and add it to Claude as a custom connector.

## Tools

| Tool | What it does |
|---|---|
| `shopify_graphql_query` | Any read-only GraphQL query |
| `shopify_graphql_mutation` | Any GraphQL mutation (orderCreate, companyCreate, metafieldsSet...) with optional idempotency key |
| `shopify_paginate` | Runs a query and follows cursors, returns the combined list |
| `shopify_schema` | Live schema explorer: list/describe queries, mutations and types |
| `shopify_rest` | Any Admin REST endpoint |
| `shopify_bulk_query` / `shopify_bulk_status` | Bulk export of large datasets (JSONL) |
| `shopify_bulk_mutation` | Bulk writes from a JSONL of variables |
| `shopify_upload_file` | Staged upload + fileCreate from a URL or base64 |
| `shopify_shop_info` | Shop details and the access scopes granted to the app |

Read tools are marked read-only, so Claude clients can treat them differently from writes.

## 1. Shopify app credentials

The app needs the scopes for what you want to do. For the order import trial: `write_orders`, `read_orders`, plus `read_customers`, `write_customers`, `read_products` and the company scopes you already use. If you want "everything", tick all scopes in the app configuration and release a new version, then install/update it on the store.

Use either:
- **Client ID + secret** (Dev Dashboard apps). The server fetches and refreshes the 24-hour token itself. Set `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`.
- **Admin API access token** (`shpat_...`). Set `SHOPIFY_ACCESS_TOKEN`.

## 2. Deploy on Render

1. Push this folder to a private GitHub repo.
2. In Render: New > Blueprint, select the repo (it reads `render.yaml`). Or New > Web Service with build `npm ci --omit=dev`, start `npm start`.
3. Set the env vars (see `.env.example`). `MCP_AUTH_TOKEN` is generated for you; copy its value.
4. Use a paid instance (Starter). On the free plan the service sleeps and the first request will fail.
5. Check `https://<service>.onrender.com/healthz`. `configProblems` should be empty.

## 3. Add it to Claude

Add a custom connector with the URL:

```
https://<service>.onrender.com/mcp/<MCP_AUTH_TOKEN>
```

Anyone who has this URL has full access to your store, so treat it as a password. Authentication also works with an `Authorization: Bearer <token>` header for clients that support headers. To rotate, change `MCP_AUTH_TOKEN` in Render and update the connector URL.

Then ask Claude to run `shopify_shop_info` to confirm the shop and scopes.

## Safety switches

- `READ_ONLY=true` blocks mutations, non-GET REST calls, bulk mutations and uploads.
- `MAX_RESPONSE_CHARS` (default 80000) truncates large replies so they don't flood the chat. For big exports use `shopify_bulk_query`.
- Failed auth attempts are rate limited per IP; the token is never logged.

## Local run

```
cp .env.example .env   # fill in, then:
set -a; . ./.env; set +a
npm install
npm start
```
