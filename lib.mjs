import { adaptersFor, byokHeaders, endpointFor } from "./adapters.mjs";
import { createCatalog } from "./catalog.mjs";
import { createDiscovery } from "./discovery.mjs";
import { accountOf, authorize, LOGIN_PROMPTS } from "./login.mjs";

export const PROVIDER_ID = "cloudflare-gateway-byok";

function compileOptions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new Error("Plugin options must be an object");
  if (
    Object.keys(options).some(
      (key) => !["providers", "adapters", "overrides"].includes(key),
    )
  ) {
    throw new Error(
      "Only providers, adapters and overrides are supported; configure the Gateway in the sign-in form",
    );
  }
  const adapters = adaptersFor(options.adapters);
  const providers = options.providers;
  if (
    providers !== undefined &&
    (!Array.isArray(providers) ||
      !providers.length ||
      providers.some((id) => !Object.hasOwn(adapters, id)))
  )
    throw new Error("providers must name registered adapters");
  const overrides = options.overrides ?? {};
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
    throw new Error("overrides must be an object");
  for (const value of Object.values(overrides)) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid model override");
    if (
      Object.keys(value).some(
        (key) =>
          ![
            "name",
            "context",
            "output",
            "tools",
            "images",
            "reasoning",
          ].includes(key),
      )
    )
      throw new Error("Unsupported model override");
    if (
      value.name !== undefined &&
      (typeof value.name !== "string" || !value.name.trim())
    )
      throw new Error("Model name must be nonempty");
    for (const field of ["context", "output"])
      if (
        value[field] !== undefined &&
        (!Number.isSafeInteger(value[field]) || value[field] <= 0)
      )
        throw new Error(`${field} must be a positive integer`);
    for (const field of ["tools", "images", "reasoning"])
      if (value[field] !== undefined && typeof value[field] !== "boolean")
        throw new Error(`${field} must be a boolean`);
  }
  return structuredClone({ adapters, providers, overrides });
}

function hostModel(key, model) {
  const flags = (list) => Object.fromEntries(list.map((v) => [v, true]));
  return {
    id: key,
    providerID: PROVIDER_ID,
    name: model.name,
    api: { id: model.id, url: model.provider.api, npm: model.provider.npm },
    limit: model.limit,
    capabilities: {
      toolcall: model.tool_call,
      reasoning: model.reasoning,
      temperature: !model.reasoning,
      attachment: model.modalities.input.includes("image"),
      input: flags(model.modalities.input),
      output: flags(model.modalities.output),
    },
    cost: {
      input: model.cost?.input ?? 0,
      output: model.cost?.output ?? 0,
      cache: {
        read: model.cost?.cache_read ?? 0,
        write: model.cost?.cache_write ?? 0,
      },
    },
    variants: model.variants ?? {},
    ...(model.discovery ? { discovery: model.discovery } : {}),
  };
}

async function annotate(response) {
  if (![401, 403].includes(response.status)) return response;
  const body = await response.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    data = {};
  }
  const codes = [data.errors, data.error]
    .flatMap((x) => (Array.isArray(x) ? x : x ? [x] : []))
    .map((x) => Number(x.code));
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set(
    "x-magpie-sign-in",
    response.status === 401 && codes.includes(2009) ? "expired" : "kept",
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function forward(input, init, scope, token, fetchImpl) {
  const { config, discovery } = scope;
  const request = new Request(input, init);
  const endpoint = Object.keys(config.adapters)
    .map((id) => endpointFor(config, id))
    .find((e) => e.url === request.url);
  if (!endpoint || request.method !== "POST")
    throw new Error(
      "Only this account's Cloudflare inference endpoints are allowed",
    );
  const body = await request.clone().json();
  const models = await discovery.get(token, { stale: true });
  if (
    typeof body?.model !== "string" ||
    !models[`${endpoint.provider}/${body.model}`]
  )
    throw new Error(
      "The requested model was not discovered for this account and endpoint",
    );
  const headers = byokHeaders(token, config.alias, request.headers);
  if (endpoint.protocol === "messages" && !headers.has("anthropic-version"))
    headers.set("anthropic-version", "2023-06-01");
  return annotate(
    await fetchImpl(new Request(request, { headers, redirect: "error" })),
  );
}

export function createPlugin(
  options = {},
  fetchImpl = globalThis.fetch,
  runtime = {},
) {
  const settings = compileOptions(options);
  const catalog = createCatalog({
    fetchImpl,
    now: runtime.now,
    directory: runtime.directory,
  });
  const scopes = new Map();
  function scopeFor(account) {
    const { accountId, gatewayId, alias } = account;
    const key = JSON.stringify([accountId, gatewayId, alias]);
    if (!scopes.has(key)) {
      if (scopes.size >= 32) scopes.delete(scopes.keys().next().value);
      const config = {
        ...settings,
        accountId,
        gatewayId,
        alias,
        root: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}`,
      };
      scopes.set(key, {
        config,
        discovery: createDiscovery(config, { ...runtime, fetchImpl, catalog }),
      });
    }
    return scopes.get(key);
  }
  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[PROVIDER_ID] ??= {
        name: "Cloudflare AI Gateway",
        npm: "@ai-sdk/openai-compatible",
        models: {},
      };
    },
    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "api",
          label: "Cloudflare AI Gateway token",
          placeholder: "AI Gateway Run and Read token",
          prompts: LOGIN_PROMPTS,
          authorize,
        },
      ],
      async loader(getAuth) {
        accountOf(await getAuth());
        return {
          apiKey: "managed-by-cloudflare-byok",
          async fetch(input, init) {
            const account = accountOf(await getAuth());
            return forward(
              input,
              init,
              scopeFor(account),
              account.token,
              fetchImpl,
            );
          },
        };
      },
    },
    provider: {
      id: PROVIDER_ID,
      async models(_provider, { auth } = {}) {
        if (!auth) return {};
        const account = accountOf(auth);
        const models = await scopeFor(account).discovery.get(account.token);
        return Object.fromEntries(
          Object.entries(models).map(([key, model]) => [
            key,
            hostModel(key, model),
          ]),
        );
      },
    },
  };
}
