import assert from "node:assert/strict";
import { test } from "node:test";
import entry from "../index.mjs";
import { createPlugin, PROVIDER_ID } from "../lib.mjs";
import {
  authorize,
  LOGIN_PROMPTS,
  loginMetadata,
  accountOf,
} from "../login.mjs";

const accountId = "a".repeat(32);
const metadata = loginMetadata({
  accountId,
  gatewayId: "test-gateway",
  alias: "production",
});
const auth = { type: "api", key: "test-gateway-token", metadata };
const root = `https://gateway.ai.cloudflare.com/v1/${accountId}/test-gateway`;
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });

function fixture(inference = async () => new Response(), options = {}) {
  const calls = [];
  const plugin = createPlugin(options, async (request) => {
    calls.push(request);
    const url = new URL(request.url);
    if (url.hostname === "models.dev")
      return json({
        deepseek: { models: { "test-model": { tool_call: true } } },
      });
    if (url.hostname === "api.cloudflare.com")
      return json({
        result: ["openai", "anthropic", "deepseek"].flatMap((provider_slug) =>
          ["production", "default", "other"].map((alias) => ({
            provider_slug,
            alias,
          })),
        ),
      });
    if (request.method === "GET") return json({ data: [{ id: "test-model" }] });
    return inference(request);
  });
  return { plugin, calls };
}
const request = (extra = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "test-model",
    messages: [{ role: "user", content: "test" }],
    stream: true,
  }),
  ...extra,
});

test("public module exports only the plugin object and exposes login prompts", async () => {
  assert.deepEqual(Object.keys(await import("../index.mjs")), ["default"]);
  const plugin = await entry.server({}, {});
  assert.equal(plugin.auth.provider, PROVIDER_ID);
  assert.deepEqual(
    plugin.auth.methods[0].prompts.map((p) => p.key),
    ["accountId", "gatewayId", "alias"],
  );
});

test("login validates fields and stores a stable account identity without credentials", async () => {
  const result = authorize({
    accountId: ` ${accountId.toUpperCase()} `,
    gatewayId: " test-gateway ",
    alias: " ",
  });
  assert.equal(result.type, "success");
  assert.deepEqual(result.metadata, {
    accountId,
    gatewayId: "test-gateway",
    alias: "default",
    email: `test-gateway · ${accountId} · default`,
  });
  assert.equal(Object.hasOwn(result, "key"), false);
  assert.notEqual(
    loginMetadata({ ...metadata, alias: "other" }).email,
    metadata.email,
  );
  assert.notEqual(
    loginMetadata({ ...metadata, accountId: "b".repeat(32) }).email,
    metadata.email,
  );
  assert.notEqual(
    loginMetadata({ ...metadata, gatewayId: "another" }).email,
    metadata.email,
  );
});

test("UI validators and authorize reject invalid Account IDs, gateways and aliases", () => {
  for (const inputs of [
    {},
    { ...metadata, accountId: "bad" },
    { ...metadata, gatewayId: "../other" },
    { ...metadata, gatewayId: "Uppercase" },
    { ...metadata, gatewayId: "a".repeat(65) },
    { ...metadata, alias: "prod\nheader" },
  ])
    assert.equal(authorize(inputs).type, "failed");
  assert.equal(LOGIN_PROMPTS[0].validate(accountId), undefined);
  assert.equal(LOGIN_PROMPTS[1].validate("test-gateway"), undefined);
  assert.equal(LOGIN_PROMPTS[2].validate(""), undefined);
  assert.equal(LOGIN_PROMPTS[2].validate(undefined), undefined);
  assert.ok(
    LOGIN_PROMPTS.every((p) => typeof p.validate("../invalid") === "string"),
  );
});

test("empty plugin options are enough; unsigned accounts expose no models", async () => {
  const { plugin } = fixture();
  const config = {};
  await plugin.config(config);
  assert.deepEqual(config.provider[PROVIDER_ID].models, {});
  assert.deepEqual(await plugin.provider.models({}), {});
  assert.ok(Object.keys(await plugin.provider.models({}, { auth })).length > 0);
});

test("old configuration fields are rejected instead of silently translated", () => {
  for (const option of [
    { accountId },
    { gatewayId: "old" },
    { aliases: {} },
    { models: {} },
    { discover: false },
  ])
    assert.throws(
      () => createPlugin(option),
      /Only providers, adapters and overrides/,
    );
  assert.throws(
    () => accountOf({ type: "api", key: "valid-token" }),
    /sign in again/,
  );
  assert.throws(
    () =>
      accountOf({ ...auth, metadata: { account: accountId, gateway: "old" } }),
    /sign in again/,
  );
});

for (const [path, settings] of [
  ["openai/responses", {}],
  ["openai/chat/completions", { adapters: { openai: { protocol: "chat" } } }],
  ["anthropic/v1/messages", {}],
  ["deepseek/chat/completions", {}],
]) {
  test(`${path} selects the account's Gateway, strips injected credentials and enforces BYOK`, async () => {
    let sent;
    const response = new Response("stream");
    const { plugin } = fixture(async (r) => {
      sent = r;
      return response;
    }, settings);
    const loader = await plugin.auth.loader(async () => auth);
    assert.equal(loader.baseURL, undefined);
    assert.equal(loader.apiKey, "managed-by-cloudflare-byok");
    const input = request({
      headers: {
        authorization: "Bearer injected",
        "x-api-key": "injected",
        "api-key": "injected",
        "x-goog-api-key": "injected",
        "proxy-authorization": "injected",
        cookie: "secret=hidden",
        host: "evil.example",
        "cf-aig-gateway-id": "wrong",
        "cf-aig-byok-alias": "wrong",
        "cf-aig-no-wholesale": "false",
        "anthropic-beta": "test-feature",
      },
    });
    assert.equal(await loader.fetch(`${root}/${path}`, input), response);
    for (const key of [
      "authorization",
      "x-api-key",
      "api-key",
      "x-goog-api-key",
      "proxy-authorization",
      "cookie",
      "host",
      "cf-aig-gateway-id",
    ])
      assert.equal(sent.headers.has(key), false);
    assert.equal(
      sent.headers.get("cf-aig-authorization"),
      `Bearer ${auth.key}`,
    );
    assert.equal(sent.headers.get("cf-aig-byok-alias"), "production");
    assert.equal(sent.headers.get("cf-aig-no-wholesale"), "true");
    assert.equal(sent.headers.get("anthropic-beta"), "test-feature");
    if (path.startsWith("anthropic"))
      assert.equal(sent.headers.get("anthropic-version"), "2023-06-01");
    assert.equal(sent.redirect, "error");
    assert.equal(await sent.text(), input.body);
  });
}

test("default alias is selected from the account rather than request headers", async () => {
  let sent;
  const { plugin } = fixture(async (r) => {
    sent = r;
    return new Response();
  });
  const loader = await plugin.auth.loader(async () => ({
    ...auth,
    metadata: { ...metadata, alias: "" },
  }));
  await loader.fetch(
    `${root}/deepseek/chat/completions`,
    request({ headers: { "cf-aig-byok-alias": "injected" } }),
  );
  assert.equal(sent.headers.get("cf-aig-byok-alias"), "default");
});

test("the same Token used for different Gateways and aliases has separate model discovery scopes", async () => {
  const { plugin, calls } = fixture();
  const accounts = [
    auth,
    { ...auth, metadata: { ...metadata, gatewayId: "second" } },
    { ...auth, metadata: { ...metadata, alias: "other" } },
  ];
  for (const account of accounts)
    await plugin.provider.models({}, { auth: account });
  assert.equal(
    calls.filter((r) => r.url.includes("provider_configs")).length,
    3,
  );
  assert.equal(calls.filter((r) => r.url.includes("models.dev")).length, 1);
  const second = await plugin.auth.loader(async () => accounts[1]);
  await assert.rejects(
    second.fetch(`${root}/deepseek/chat/completions`, request()),
    /this account/,
  );
  await second.fetch(
    `${root.replace("test-gateway", "second")}/deepseek/chat/completions`,
    request(),
  );
  assert.equal(calls.at(-1).url.includes("/second/deepseek/"), true);
});

test("a loader reads the current token and metadata on every request", async () => {
  const sent = [];
  const { plugin } = fixture(async (r) => {
    sent.push({
      url: r.url,
      token: r.headers.get("cf-aig-authorization"),
      alias: r.headers.get("cf-aig-byok-alias"),
    });
    return new Response();
  });
  let current = auth;
  const loader = await plugin.auth.loader(async () => current);
  await loader.fetch(`${root}/deepseek/chat/completions`, request());
  current = {
    ...auth,
    key: "rotated-token",
    metadata: { ...metadata, gatewayId: "second", alias: "other" },
  };
  await loader.fetch(
    `${root.replace("test-gateway", "second")}/deepseek/chat/completions`,
    request(),
  );
  assert.equal(sent[1].token, "Bearer rotated-token");
  assert.equal(sent[1].alias, "other");
});

test("Request inputs retain body and cancellation reaches transport", async () => {
  let sent;
  const { plugin } = fixture(async (r) => {
    sent = r;
    return new Response();
  });
  const loader = await plugin.auth.loader(async () => auth);
  const controller = new AbortController();
  await loader.fetch(
    new Request(
      `${root}/deepseek/chat/completions`,
      request({ signal: controller.signal }),
    ),
  );
  controller.abort(new Error("Client disconnected"));
  assert.equal(sent.signal.aborted, true);
  assert.equal(sent.signal.reason.message, "Client disconnected");
  assert.equal((await sent.json()).model, "test-model");
});

test("streaming responses stay unread and errors keep their original status", async () => {
  let controller;
  const response = new Response(
    new ReadableStream({
      start(c) {
        controller = c;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const { plugin } = fixture(async () => response);
  const loader = await plugin.auth.loader(async () => auth);
  const result = await loader.fetch(
    `${root}/deepseek/chat/completions`,
    request(),
  );
  assert.equal(result, response);
  assert.equal(result.bodyUsed, false);
  const reader = result.body.getReader();
  controller.enqueue(new TextEncoder().encode("data: first\n\n"));
  assert.equal(
    new TextDecoder().decode((await reader.read()).value),
    "data: first\n\n",
  );
  controller.close();
  for (const status of [400, 401, 403, 429, 500]) {
    const { plugin } = fixture(async () => json({ error: "upstream" }, status));
    const loader = await plugin.auth.loader(async () => auth);
    const result = await loader.fetch(
      `${root}/deepseek/chat/completions`,
      request(),
    );
    assert.equal(result.status, status);
    if ([401, 403].includes(status))
      assert.equal(result.headers.get("x-magpie-sign-in"), "kept");
  }
});

test("invalid destinations and undiscovered models cannot reach inference", async () => {
  const { plugin, calls } = fixture();
  const loader = await plugin.auth.loader(async () => auth);
  for (const url of [
    "https://evil.example/chat/completions",
    `${root}/deepseek/chat/completions?key=secret`,
    `${root}/deepseek/chat/completions/extra`,
    root.replace("test-gateway", "wrong") + "/deepseek/chat/completions",
  ])
    await assert.rejects(loader.fetch(url, request()), /endpoints/);
  assert.equal(calls.length, 0);
  await assert.rejects(
    loader.fetch(`${root}/deepseek/chat/completions`, { method: "GET" }),
    /endpoints/,
  );
  await assert.rejects(
    loader.fetch(
      `${root}/deepseek/chat/completions`,
      request({ body: JSON.stringify({ model: "not-listed" }) }),
    ),
    /not discovered/,
  );
  assert.equal(
    calls.some((r) => r.method === "POST"),
    false,
  );
});

test("pasted tokens lose surrounding whitespace only", () => {
  assert.equal(accountOf({ ...auth, key: ` ${auth.key}\n` }).token, auth.key);
});

test("invalid token or metadata fail before network access", async () => {
  const { plugin, calls } = fixture();
  for (const value of [
    undefined,
    { type: "oauth" },
    { ...auth, key: "" },
    { ...auth, key: "token\r\nheader" },
    { ...auth, key: "Bearer token" },
    { ...auth, metadata: {} },
  ])
    await assert.rejects(plugin.auth.loader(async () => value));
  assert.equal(calls.length, 0);
});
