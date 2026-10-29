import { createHash } from "node:crypto";
import { byokHeaders, endpointFor } from "./adapters.mjs";
import { modelMetadata } from "./catalog.mjs";

const LIST_TTL = 10 * 60 * 1000;
const RETRY_TTL = 30_000;

async function getJSON(url, headers, fetchImpl, controlPlane = false) {
  let response;
  try {
    response = await fetchImpl(
      new Request(url, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      }),
    );
  } catch {
    throw new Error("Discovery request failed or timed out");
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("Discovery returned invalid JSON");
  }
  if (!response.ok || body?.success === false) {
    const errors = [body?.errors, body?.error].flatMap((x) =>
      Array.isArray(x) ? x : x && typeof x === "object" ? [x] : [],
    );
    const codes = errors.map((e) => Number(e.code));
    const error = Object.assign(
      new Error(`Discovery HTTP ${response.status}`),
      {
        status: response.status,
        noKey: codes.some((c) => [2040, 2044].includes(c)),
      },
    );
    if (
      (controlPlane && response.status === 401) ||
      (!controlPlane && response.status === 401 && codes.includes(2009))
    ) {
      error.signIn = "expired";
      error.message = "Cloudflare refused the Gateway token; sign in again";
    }
    throw error;
  }
  return body;
}

async function storedProviders(config, token, fetchImpl) {
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai-gateway/gateways/${config.gatewayId}/provider_configs?page=${page}&per_page=100`;
    const body = await getJSON(
      url,
      { authorization: `Bearer ${token}`, accept: "application/json" },
      fetchImpl,
      true,
    );
    if (!Array.isArray(body.result))
      throw new Error("Invalid provider configuration response");
    // Do not retain secret previews, secret IDs or any other credential metadata.
    rows.push(
      ...body.result.map((r) => ({
        slug: r.provider_slug,
        alias: r.alias || "default",
      })),
    );
    const total = body.result_info?.total_pages;
    if (Number.isSafeInteger(total) ? page >= total : body.result.length < 100)
      return rows;
  }
  throw new Error("Provider configuration pagination limit reached");
}

async function liveModels(config, provider, token, fetchImpl) {
  const adapter = config.adapters[provider];
  const headers = byokHeaders(token, config.alias, {
    accept: "application/json",
  });
  if (adapter.format === "anthropic")
    headers.set("anthropic-version", "2023-06-01");
  const url = new URL(`${config.root}/${adapter.slug}${adapter.modelsPath}`);
  if (adapter.format === "anthropic") url.searchParams.set("limit", "1000");
  if (adapter.format === "google") url.searchParams.set("pageSize", "1000");
  const entries = new Map();
  const cursors = new Set();
  for (let page = 0; page < 20; page++) {
    const body = await getJSON(url, headers, fetchImpl);
    const rows = adapter.format === "google" ? body.models : body.data;
    if (!Array.isArray(rows)) throw new Error("Invalid vendor model list");
    for (const row of rows) {
      if (
        adapter.format === "google" &&
        !row.supportedGenerationMethods?.includes("generateContent")
      )
        continue;
      const id =
        adapter.format === "google"
          ? row.name?.replace(/^models\//, "")
          : row.id;
      if (
        typeof id !== "string" ||
        !id ||
        /[\x00-\x20\x7f]/.test(id) ||
        id.length > 256
      )
        continue;
      entries.set(id, {
        id,
        name: row.display_name ?? row.displayName ?? row.name,
        context: row.inputTokenLimit ?? row.context_length,
        output: row.outputTokenLimit ?? row.top_provider?.max_completion_tokens,
        tools: row.capabilities?.function_calling,
      });
    }
    let cursor;
    if (adapter.format === "google") cursor = body.nextPageToken;
    if (adapter.format === "anthropic" && body.has_more)
      cursor = body.last_id ?? rows.at(-1)?.id;
    if (!cursor) {
      if (body.has_more)
        throw new Error("Missing model list pagination cursor");
      return [...entries.values()];
    }
    if (typeof cursor !== "string" || cursors.has(cursor))
      throw new Error("Invalid model list pagination cursor");
    cursors.add(cursor);
    url.searchParams.set(
      adapter.format === "google" ? "pageToken" : "after_id",
      cursor,
    );
  }
  throw new Error("Model list pagination limit reached");
}

function usableModel(id, meta, provider) {
  if (
    meta.status === "deprecated" ||
    (meta.modalities?.output && !meta.modalities.output.includes("text"))
  )
    return false;
  if (
    /(?:embed|whisper|tts|dall-e|moderation|realtime|image|audio|transcribe|lyria|nano-banana)/i.test(
      id,
    )
  )
    return false;
  if (
    provider === "openai" &&
    /^(babbage|davinci)-|-instruct(?:-|$)|-search-(?:api|preview)(?:-|$)/.test(
      id,
    )
  )
    return false;
  return true;
}

function definition(config, provider, row, meta, stale) {
  const override = config.overrides[`${provider}/${row.id}`] ?? {};
  const unknown = [];
  const positive = (value) => Number.isSafeInteger(value) && value > 0;
  function capacity(field, fallback) {
    for (const value of [override[field], row[field], meta.limit?.[field]])
      if (positive(value)) return value;
    unknown.push(field);
    return fallback;
  }
  const context = capacity("context", 8192);
  const output = Math.min(capacity("output", 1024), context);
  function capability(field, value) {
    const selected = override[field] ?? value;
    if (typeof selected === "boolean") return selected;
    unknown.push(field);
    return false;
  }
  const endpoint = endpointFor(config, provider);
  const tools = capability("tools", row.tools ?? meta.tool_call);
  const images = capability(
    "images",
    meta.modalities?.input
      ? meta.modalities.input.includes("image")
      : undefined,
  );
  const reasoning = capability("reasoning", meta.reasoning);
  const model = {
    id: row.id,
    name: override.name ?? row.name ?? meta.name ?? row.id,
    provider: { npm: endpoint.npm, api: endpoint.api },
    limit: { context, output },
    tool_call: tools,
    reasoning,
    modalities: {
      input: images ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    discovery: {
      provider,
      source: "vendor",
      metadata: Object.keys(meta).length ? "models.dev" : "unknown",
      unknown,
      stale,
    },
  };
  if (meta.cost) model.cost = { ...meta.cost };
  // Only advertise reasoning levels actually supplied by the catalog.
  const efforts = meta.reasoning_options?.find(
    (x) => x.type === "effort",
  )?.values;
  if (reasoning && Array.isArray(efforts))
    model.variants = Object.fromEntries(
      efforts.filter((v) => typeof v === "string").map((v) => [v, {}]),
    );
  return model;
}

export function createDiscovery(
  config,
  { fetchImpl, catalog, now = Date.now, log = () => {} },
) {
  const accounts = new Map();
  const keyOf = (token) =>
    createHash("sha256").update(`${config.root}\n${token}`).digest("hex");

  async function collect(token, prior) {
    const diagnostics = [];
    let rows;
    let transient = false;
    try {
      rows = await storedProviders(config, token, fetchImpl);
    } catch (error) {
      if (error.signIn) throw error;
      transient = error.status !== 403;
      diagnostics.push({
        code:
          error.status === 403
            ? "read_permission_required"
            : "provider_discovery_unavailable",
        message:
          "Cannot read BYOK providers. Check AI Gateway Read; probing only live vendor lists.",
      });
    }
    const entries = Object.entries(config.adapters).filter(
      ([id]) => !config.providers || config.providers.includes(id),
    );
    if (rows) {
      const known = new Set(
        Object.values(config.adapters).map((a) => a.slug),
      );
      for (const slug of new Set(rows.map((r) => r.slug)))
        if (!known.has(slug))
          diagnostics.push({ code: "unsupported_provider", provider: slug });
    }
    const selected = entries.filter(
      ([id, adapter]) =>
        !rows ||
        rows.some((r) => r.slug === adapter.slug && r.alias === config.alias),
    );
    const previous = prior?.byProvider ?? {};
    const byProvider = {};
    // Limit concurrent vendor probes, especially on the no-Read-permission path.
    for (let offset = 0; offset < selected.length; offset += 4) {
      await Promise.all(
        selected.slice(offset, offset + 4).map(async ([id]) => {
          try {
            byProvider[id] = {
              rows: await liveModels(config, id, token, fetchImpl),
              stale: false,
            };
          } catch (error) {
            if (error.signIn) throw error;
            if (error.noKey || [401, 403].includes(error.status)) {
              diagnostics.push({
                code: error.noKey
                  ? "missing_byok_key"
                  : "vendor_credentials_refused",
                provider: id,
              });
              return;
            }
            transient = true;
            if (previous[id]) byProvider[id] = { ...previous[id], stale: true };
            diagnostics.push({
              code: previous[id]
                ? "stale_model_list"
                : "model_list_unavailable",
              provider: id,
            });
          }
        }),
      );
    }
    const metadata = selected.length ? await catalog() : {};
    const models = Object.create(null);
    for (const [provider, list] of Object.entries(byProvider)) {
      for (const row of list.rows) {
        const meta = modelMetadata(
          metadata,
          config.adapters[provider].catalog,
          row.id,
        );
        if (!usableModel(row.id, meta, provider)) continue;
        models[`${provider}/${row.id}`] = definition(
          config,
          provider,
          row,
          meta,
          list.stale,
        );
      }
    }
    for (const diagnostic of diagnostics) log(diagnostic);
    return { models, byProvider, ttl: transient ? RETRY_TTL : LIST_TTL };
  }

  function refresh(key, entry, token) {
    entry.pending ??= collect(token, entry.value)
      .then(
        (result) => {
          entry.value = result;
          entry.expires = now() + result.ttl;
          return result;
        },
        (error) => {
          if (error.signIn) accounts.delete(key);
          throw error;
        },
      )
      .finally(() => {
        entry.pending = undefined;
      });
    return entry.pending;
  }

  return {
    // With `stale`, an expired list is returned at once and refreshed in the background.
    async get(token, { stale = false } = {}) {
      const key = keyOf(token);
      let entry = accounts.get(key);
      if (!entry) {
        if (accounts.size >= 32) {
          const idle = [...accounts].find(([, value]) => !value.pending);
          if (idle) accounts.delete(idle[0]);
        }
        entry = { expires: 0 };
        accounts.set(key, entry);
      }
      if (entry.value && (stale || now() < entry.expires)) {
        if (now() >= entry.expires) refresh(key, entry, token).catch(() => {});
        return structuredClone(entry.value.models);
      }
      return structuredClone((await refresh(key, entry, token)).models);
    },
  };
}
