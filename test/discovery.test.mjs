import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptersFor } from "../adapters.mjs";
import { modelMetadata } from "../catalog.mjs";
import { createPlugin } from "../lib.mjs";

const accountId = "a".repeat(32);
const base = `https://gateway.ai.cloudflare.com/v1/${accountId}/test`;
const opts = () => ({});
const auth = {
  type: "api",
  key: "secret-one",
  metadata: { accountId, gatewayId: "test", alias: "default" },
};
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const failure = (code, status = 400) => json({ error: [{ code }] }, status);
const row = (provider, alias = "default") => ({
  provider_slug: provider,
  alias,
  secret_preview: "do-not-retain",
  secret_id: "private",
});
const catalog = {
  deepseek: {
    models: {
      "test-chat": {
        limit: { context: 64000, output: 8192 },
        tool_call: true,
        reasoning: true,
        modalities: { input: ["text"], output: ["text"] },
      },
    },
  },
};
const listing = (plugin, token = auth) =>
  plugin.provider.models({}, { auth: token });

function fixture({
  control = () => json({ result: [row("deepseek")] }),
  vendor = () => json({ data: [{ id: "test-chat" }] }),
  metadata = () => json(catalog),
  inference = () => json({ ok: true }),
} = {}) {
  const requests = [];
  const fetchImpl = async (request) => {
    requests.push(request);
    const url = new URL(request.url);
    if (url.hostname === "models.dev") {
      assert.equal(request.headers.has("cf-aig-authorization"), false);
      assert.equal(request.headers.has("authorization"), false);
      return metadata(request);
    }
    if (url.hostname === "api.cloudflare.com") return control(request);
    assert.equal(url.hostname, "gateway.ai.cloudflare.com");
    assert.equal(request.headers.has("authorization"), false);
    assert.equal(request.headers.get("cf-aig-no-wholesale"), "true");
    assert.equal(request.redirect, "error");
    return request.method === "POST" ? inference(request) : vendor(request);
  };
  return { requests, fetchImpl };
}

test("auto mode needs no models, discovers stored providers and enriches only live IDs", async () => {
  const f = fixture();
  const plugin = createPlugin(opts(), f.fetchImpl);
  const models = await listing(plugin);
  assert.deepEqual(Object.keys(models), ["deepseek/test-chat"]);
  const model = models["deepseek/test-chat"];
  assert.equal(model.api.url, `${base}/deepseek`);
  assert.equal(model.api.id, "test-chat");
  assert.equal(model.capabilities.toolcall, true);
  assert.equal(model.limit.context, 64000);
  assert.equal(model.discovery.metadata, "models.dev");
  assert.equal(JSON.stringify(models).includes("do-not-retain"), false);
  const loader = await plugin.auth.loader(async () => auth);
  const response = await loader.fetch(`${model.api.url}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: model.api.id }),
  });
  assert.equal(response.status, 200);
  assert.equal(
    f.requests.filter((r) => r.url.includes("provider_configs")).length,
    1,
  );
});

test("403 falls back to live lists; missing keys never acquire catalog models", async () => {
  const diagnostics = [];
  const f = fixture({
    control: () => failure(10000, 403),
    vendor: (r) =>
      r.url.includes("/deepseek/")
        ? json({ data: [{ id: "test-chat" }] })
        : failure(2040),
  });
  const plugin = createPlugin(opts(), f.fetchImpl, {
    log: (d) => diagnostics.push(d),
  });
  assert.deepEqual(Object.keys(await listing(plugin)), ["deepseek/test-chat"]);
  assert.ok(diagnostics.some((d) => d.code === "read_permission_required"));
  assert.equal(
    f.requests.filter(
      (r) => new URL(r.url).hostname === "gateway.ai.cloudflare.com",
    ).length,
    Object.keys(adaptersFor()).length,
  );
});

test("explicit provider selection bounds no-Read probing", async () => {
  const f = fixture({ control: () => failure(10000, 403) });
  await listing(
    createPlugin({ ...opts(), providers: ["deepseek"] }, f.fetchImpl),
  );
  assert.equal(
    f.requests.filter(
      (r) => new URL(r.url).hostname === "gateway.ai.cloudflare.com",
    ).length,
    1,
  );
});

test("successful empty lists and revoked provider configurations remove cached models", async () => {
  let time = 1,
    state = "normal";
  const f = fixture({
    control: () =>
      json({ result: state === "revoked" ? [] : [row("deepseek")] }),
    vendor: () =>
      json({ data: state === "empty" ? [] : [{ id: "test-chat" }] }),
  });
  const plugin = createPlugin(opts(), f.fetchImpl, { now: () => time });
  assert.equal(Object.keys(await listing(plugin)).length, 1);
  state = "empty";
  time += 600001;
  assert.deepEqual(await listing(plugin), {});
  state = "normal";
  time += 600001;
  assert.equal(Object.keys(await listing(plugin)).length, 1);
  state = "revoked";
  time += 600001;
  assert.deepEqual(await listing(plugin), {});
  const loader = await plugin.auth.loader(async () => auth);
  await assert.rejects(
    loader.fetch(`${base}/deepseek/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "test-chat" }),
    }),
    /not discovered/,
  );
});

for (const code of [2040, 2044])
  test(`missing key ${code} clears stale models`, async () => {
    let time = 1,
      missing = false;
    const f = fixture({
      vendor: () =>
        missing ? failure(code) : json({ data: [{ id: "test-chat" }] }),
    });
    const plugin = createPlugin(opts(), f.fetchImpl, { now: () => time });
    await listing(plugin);
    missing = true;
    time += 600001;
    assert.deepEqual(await listing(plugin), {});
  });

test("transient listing failure retains only previously successful account models", async () => {
  let time = 1,
    down = false;
  const f = fixture({
    vendor: () =>
      down ? failure(5000, 503) : json({ data: [{ id: "test-chat" }] }),
  });
  const plugin = createPlugin(opts(), f.fetchImpl, { now: () => time });
  await listing(plugin);
  down = true;
  time += 600001;
  const stale = await listing(plugin);
  assert.equal(stale["deepseek/test-chat"].discovery.stale, true);
  assert.deepEqual(
    await listing(plugin, { ...auth, key: "another-account" }),
    {},
  );
});

test("in-flight calls coalesce, callers cannot mutate cache, token rotation isolates lists", async () => {
  const f = fixture({
    vendor: async (r) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const id = r.headers.get("cf-aig-authorization").endsWith("secret-one")
        ? "first-model"
        : "second-model";
      return json({ data: [{ id }] });
    },
  });
  const plugin = createPlugin(opts(), f.fetchImpl);
  const [a, b] = await Promise.all([listing(plugin), listing(plugin)]);
  assert.equal(
    f.requests.filter((r) => r.url.includes("provider_configs")).length,
    1,
  );
  a["deepseek/first-model"].name = "mutated";
  assert.notEqual(b["deepseek/first-model"].name, "mutated");
  assert.deepEqual(
    Object.keys(await listing(plugin, { ...auth, key: "secret-two" })),
    ["deepseek/second-model"],
  );
});

test("expired lists keep serving inference while refreshing in the background", async () => {
  let time = 1,
    slow = false;
  const events = [];
  const f = fixture({
    vendor: async () => {
      if (slow) await new Promise((resolve) => setTimeout(resolve, 20));
      events.push("list");
      return json({ data: [{ id: "test-chat" }] });
    },
    inference: () => {
      events.push("inference");
      return json({ ok: true });
    },
  });
  const plugin = createPlugin(opts(), f.fetchImpl, { now: () => time });
  await listing(plugin);
  slow = true;
  time += 600001;
  const loader = await plugin.auth.loader(async () => auth);
  await loader.fetch(`${base}/deepseek/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "test-chat" }),
  });
  assert.deepEqual(events, ["list", "inference"]);
  assert.equal(
    (await listing(plugin))["deepseek/test-chat"].discovery.stale,
    false,
  );
  assert.deepEqual(events, ["list", "inference", "list"]);
  assert.equal(
    f.requests.filter((r) => r.url.includes("provider_configs")).length,
    2,
  );
});

test("temporary provider configuration failures retry after 30 seconds", async () => {
  let time = 1;
  const f = fixture({ control: () => failure(5000, 503) });
  const plugin = createPlugin({ providers: ["deepseek"] }, f.fetchImpl, {
    now: () => time,
  });
  await listing(plugin);
  time += 30001;
  await listing(plugin);
  assert.equal(
    f.requests.filter((r) => r.url.includes("provider_configs")).length,
    2,
  );
});

test("token refusal never uses stale account models", async () => {
  let time = 1,
    invalid = false;
  const f = fixture({
    control: () =>
      invalid ? failure(10000, 401) : json({ result: [row("deepseek")] }),
  });
  const plugin = createPlugin(opts(), f.fetchImpl, { now: () => time });
  await listing(plugin);
  invalid = true;
  time += 600001;
  await assert.rejects(listing(plugin), (e) => e.signIn === "expired");
});

test("unknown metadata uses labelled conservative limits and explicit overrides", async () => {
  const f = fixture({ metadata: () => failure(5000, 503) });
  const plugin = createPlugin(
    {
      ...opts(),
      overrides: { "deepseek/test-chat": { context: 24000, tools: true } },
    },
    f.fetchImpl,
  );
  const model = (await listing(plugin))["deepseek/test-chat"];
  assert.deepEqual(model.limit, { context: 24000, output: 1024 });
  assert.equal(model.capabilities.toolcall, true);
  assert.equal(model.discovery.metadata, "unknown");
  assert.ok(model.discovery.unknown.includes("output"));
  assert.equal(model.capabilities.reasoning, false);
});

test("an unavailable list does not import models.dev's entire provider catalog", async () => {
  const f = fixture({ vendor: () => failure(5000, 503) });
  assert.deepEqual(await listing(createPlugin(opts(), f.fetchImpl)), {});
});

test("custom adapter discovers and routes nested model IDs without extending code enums", async () => {
  const customAuth = { ...auth, metadata: { ...auth.metadata, alias: "prod" } };
  const f = fixture({
    control: () => json({ result: [row("vendor-new", "prod")] }),
    vendor: () => json({ data: [{ id: "author/chat-model" }] }),
  });
  const plugin = createPlugin(
    {
      ...opts(),
      adapters: {
        custom: {
          slug: "vendor-new",
          protocol: "chat",
          basePath: "/v1",
          modelsPath: "/v1/models",
          format: "openai",
        },
      },
    },
    f.fetchImpl,
  );
  const models = await listing(plugin, customAuth);
  assert.deepEqual(Object.keys(models), ["custom/author/chat-model"]);
  const loader = await plugin.auth.loader(async () => customAuth);
  await loader.fetch(`${base}/vendor-new/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "author/chat-model" }),
  });
  assert.equal(f.requests.at(-1).headers.get("cf-aig-byok-alias"), "prod");
});

test("alias selection matches provider metadata and reports unsupported slugs", async () => {
  const diagnostics = [];
  const f = fixture({
    control: () =>
      json({
        result: [
          row("deepseek", "prod"),
          row("anthropic", "default"),
          row("unknown"),
        ],
      }),
  });
  const plugin = createPlugin(opts(), f.fetchImpl, {
    log: (d) => diagnostics.push(d),
  });
  assert.deepEqual(
    Object.keys(
      await listing(plugin, {
        ...auth,
        metadata: { ...auth.metadata, alias: "prod" },
      }),
    ),
    ["deepseek/test-chat"],
  );
  assert.ok(diagnostics.some((d) => d.code === "unsupported_provider"));
  const live = f.requests.find((r) => r.url.includes("/deepseek/models"));
  assert.equal(live.headers.get("cf-aig-byok-alias"), "prod");
});

test("excluded built-in providers are not reported as unsupported", async () => {
  const diagnostics = [];
  const f = fixture({
    control: () =>
      json({
        result: [
          row("deepseek"),
          row("anthropic"),
          row("unknown"),
          row("unknown", "prod"),
        ],
      }),
  });
  await listing(
    createPlugin({ providers: ["deepseek"] }, f.fetchImpl, {
      log: (d) => diagnostics.push(d),
    }),
  );
  assert.deepEqual(
    diagnostics.filter((d) => d.code === "unsupported_provider"),
    [{ code: "unsupported_provider", provider: "unknown" }],
  );
});

test("vendor model IDs never resolve to prototype properties", () => {
  assert.deepEqual(modelMetadata(catalog, "deepseek", "constructor"), {});
  assert.deepEqual(modelMetadata(catalog, "toString", "test-chat"), {});
  assert.equal(
    modelMetadata(catalog, "deepseek", "test-chat-20260101").tool_call,
    true,
  );
});

test("provider configuration and Anthropic list pagination are followed", async () => {
  const f = fixture({
    control: (r) =>
      json({
        result: [row("anthropic")],
        result_info: {
          page: Number(new URL(r.url).searchParams.get("page")),
          total_pages: 2,
        },
      }),
    vendor: (r) => {
      const next = new URL(r.url).searchParams.get("after_id");
      assert.equal(r.headers.get("anthropic-version"), "2023-06-01");
      return json({
        data: [{ id: next ? "second" : "first" }],
        has_more: !next,
        last_id: "first",
      });
    },
  });
  assert.deepEqual(
    Object.keys(await listing(createPlugin(opts(), f.fetchImpl))),
    ["anthropic/first", "anthropic/second"],
  );
  assert.equal(
    f.requests.filter((r) => r.url.includes("provider_configs")).length,
    2,
  );
});

test("Google page tokens and vendor-provided capacity are preserved", async () => {
  const f = fixture({
    control: () => json({ result: [row("google-ai-studio")] }),
    vendor: (r) => {
      const next = new URL(r.url).searchParams.get("pageToken");
      return json({
        models: [
          {
            name: `models/${next ? "second" : "first"}`,
            inputTokenLimit: 12000,
            outputTokenLimit: 2000,
            supportedGenerationMethods: ["generateContent"],
          },
        ],
        ...(next ? {} : { nextPageToken: "next" }),
      });
    },
  });
  const models = await listing(createPlugin(opts(), f.fetchImpl));
  assert.deepEqual(Object.keys(models), ["google/first", "google/second"]);
  assert.deepEqual(models["google/first"].limit, {
    context: 12000,
    output: 2000,
  });
  assert.equal(
    models["google/first"].api.url,
    `${base}/google-ai-studio/v1beta/openai`,
  );
});

test("long-tail built-ins list and route through their Cloudflare paths", async () => {
  for (const [provider, slug, list, api, npm] of [
    ["cerebras", "cerebras", "/models", "", "@ai-sdk/openai-compatible"],
    ["fireworks", "fireworks", "/models", "", "@ai-sdk/openai-compatible"],
    ["perplexity", "perplexity-ai", "/v1/models", "/v1", "@ai-sdk/openai"],
  ]) {
    const f = fixture({ control: () => json({ result: [row(slug)] }) });
    const models = await listing(createPlugin(opts(), f.fetchImpl));
    assert.deepEqual(Object.keys(models), [`${provider}/test-chat`]);
    assert.equal(
      models[`${provider}/test-chat`].api.url,
      `${base}/${slug}${api}`,
    );
    assert.equal(models[`${provider}/test-chat`].api.npm, npm);
    assert.ok(f.requests.some((r) => r.url === `${base}/${slug}${list}`));
  }
});

test("public catalog disk cache survives an offline restart without storing tokens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "byok-catalog-"));
  try {
    const f = fixture();
    await listing(createPlugin(opts(), f.fetchImpl, { directory }));
    const saved = await readFile(
      join(directory, "cloudflare-byok-models-dev.json"),
      "utf8",
    );
    assert.equal(saved.includes(auth.key), false);
    assert.equal(saved.includes("do-not-retain"), false);
    const offline = fixture({
      metadata: () =>
        assert.fail("Fresh disk cache should avoid a catalog request"),
    });
    assert.equal(
      (await listing(createPlugin(opts(), offline.fetchImpl, { directory })))[
        "deepseek/test-chat"
      ].limit.context,
      64000,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unsafe adapters and unregistered provider selectors fail locally", () => {
  for (const change of [
    {
      adapters: {
        custom: {
          slug: "vendor",
          protocol: "chat",
          basePath: "https://evil.test",
          modelsPath: "/models",
          format: "openai",
        },
      },
    },
    {
      adapters: {
        custom: {
          slug: "vendor",
          protocol: "chat",
          basePath: "/../other",
          modelsPath: "/models",
          format: "openai",
        },
      },
    },
    {
      adapters: {
        custom: {
          slug: "vendor",
          protocol: "chat",
          basePath: "",
          modelsPath: "/models?key=secret",
          format: "openai",
        },
      },
    },
    { providers: ["missing"] },
    { discover: "false" },
    { overrides: { "deepseek/x": { output: -1 } } },
  ])
    assert.throws(() => createPlugin({ ...opts(), ...change }));
});

test("upstream 401 keeps the Gateway sign-in while Gateway 2009 expires it", async () => {
  for (const code of ["invalid_api_key", 2009]) {
    const f = fixture({ inference: () => failure(code, 401) });
    const plugin = createPlugin(opts(), f.fetchImpl);
    await listing(plugin);
    const loader = await plugin.auth.loader(async () => auth);
    const response = await loader.fetch(`${base}/deepseek/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "test-chat" }),
    });
    assert.equal(response.status, 401);
    assert.equal(
      response.headers.get("x-magpie-sign-in"),
      code === 2009 ? "expired" : "kept",
    );
  }
});
