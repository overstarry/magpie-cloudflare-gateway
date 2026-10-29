const APIS = {
  chat: { npm: "@ai-sdk/openai-compatible", path: "/chat/completions" },
  responses: { npm: "@ai-sdk/openai", path: "/responses" },
  messages: { npm: "@ai-sdk/anthropic", path: "/messages" },
};

// Paths are relative to Cloudflare's provider slug, never arbitrary origins.
const BUILTINS = {
  openai: {
    slug: "openai",
    protocol: "responses",
    basePath: "",
    modelsPath: "/models",
    format: "openai",
    catalog: "openai",
  },
  anthropic: {
    slug: "anthropic",
    protocol: "messages",
    basePath: "/v1",
    modelsPath: "/v1/models",
    format: "anthropic",
    catalog: "anthropic",
  },
  deepseek: {
    slug: "deepseek",
    protocol: "chat",
    basePath: "",
    modelsPath: "/models",
    format: "openai",
    catalog: "deepseek",
  },
  google: {
    slug: "google-ai-studio",
    protocol: "chat",
    basePath: "/v1beta/openai",
    modelsPath: "/v1beta/models",
    format: "google",
    catalog: "google",
  },
  xai: {
    slug: "grok",
    protocol: "chat",
    basePath: "/v1",
    modelsPath: "/v1/models",
    format: "openai",
    catalog: "xai",
  },
  groq: {
    slug: "groq",
    protocol: "chat",
    basePath: "",
    modelsPath: "/models",
    format: "openai",
    catalog: "groq",
  },
  mistral: {
    slug: "mistral",
    protocol: "chat",
    basePath: "/v1",
    modelsPath: "/v1/models",
    format: "openai",
    catalog: "mistral",
  },
  openrouter: {
    slug: "openrouter",
    protocol: "chat",
    basePath: "",
    modelsPath: "/models",
    format: "openai",
    catalog: "openrouter",
  },
};

export function adaptersFor(custom = {}) {
  if (!custom || typeof custom !== "object" || Array.isArray(custom))
    throw new Error("adapters must be an object");
  const registry = structuredClone(BUILTINS);
  for (const [name, value] of Object.entries(custom)) {
    if (
      !/^[a-z][a-z0-9-]*$/.test(name) ||
      ["constructor", "prototype"].includes(name)
    )
      throw new Error("Invalid adapter name");
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid adapter definition");
    if (
      Object.keys(value).some(
        (k) =>
          ![
            "slug",
            "protocol",
            "basePath",
            "modelsPath",
            "format",
            "catalog",
          ].includes(k),
      )
    )
      throw new Error("Unknown adapter field");
    const a = { ...registry[name], ...value };
    if (!/^[a-z][a-z0-9-]*$/.test(a.slug) || !Object.hasOwn(APIS, a.protocol))
      throw new Error("Invalid adapter slug or protocol");
    for (const field of ["basePath", "modelsPath"]) {
      const path = a[field];
      if (
        typeof path !== "string" ||
        !/^(?:\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)*$/.test(path) ||
        (field === "modelsPath" && !path)
      ) {
        throw new Error(
          "Adapter paths must be relative paths without traversal, query or credentials",
        );
      }
    }
    if (!["openai", "anthropic", "google"].includes(a.format))
      throw new Error("Unsupported model list format");
    if (
      a.catalog !== undefined &&
      (typeof a.catalog !== "string" || !/^[a-z0-9-]+$/.test(a.catalog))
    )
      throw new Error("Invalid catalog name");
    registry[name] = a;
  }
  const slugs = Object.values(registry).map((a) => a.slug);
  if (new Set(slugs).size !== slugs.length)
    throw new Error("Adapter slugs must be unique");
  return registry;
}

export function endpointFor(config, provider) {
  const adapter = config.adapters[provider];
  const { protocol } = adapter;
  const api = `${config.root}/${adapter.slug}${adapter.basePath}`;
  return {
    provider,
    protocol,
    api,
    url: `${api}${APIS[protocol].path}`,
    npm: APIS[protocol].npm,
  };
}

export function byokHeaders(token, alias, original) {
  const headers = new Headers(original);
  for (const key of [
    "authorization",
    "x-api-key",
    "api-key",
    "x-goog-api-key",
    "proxy-authorization",
    "cookie",
    "cf-aig-byok-alias",
    "host",
    "content-length",
    "cf-aig-gateway-id",
  ])
    headers.delete(key);
  headers.set("cf-aig-authorization", `Bearer ${token}`);
  headers.set("cf-aig-no-wholesale", "true");
  if (alias) headers.set("cf-aig-byok-alias", alias);
  return headers;
}
