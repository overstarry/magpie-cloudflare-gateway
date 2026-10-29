const ACCOUNT_ID = /^[a-f0-9]{32}$/i;
const GATEWAY_ID = /^[a-z0-9_]+(?:-[a-z0-9_]+)*$/;
const ALIAS = /^[A-Za-z0-9_-]{1,64}$/;

export function loginMetadata(input) {
  const accountId =
    typeof input?.accountId === "string"
      ? input.accountId.trim().toLowerCase()
      : "";
  const gatewayId =
    typeof input?.gatewayId === "string" ? input.gatewayId.trim() : "";
  const alias =
    typeof input?.alias === "string"
      ? input.alias.trim() || "default"
      : "default";
  if (!ACCOUNT_ID.test(accountId))
    throw new Error(
      "Cloudflare Account ID must contain 32 hexadecimal characters",
    );
  if (gatewayId.length > 64 || !GATEWAY_ID.test(gatewayId))
    throw new Error(
      "Gateway ID must contain lowercase letters, digits, underscores or hyphens (up to 64 characters)",
    );
  if (!ALIAS.test(alias))
    throw new Error(
      "BYOK alias must contain letters, digits, underscores or hyphens (up to 64 characters)",
    );
  // Magpie uses metadata.email as both the account label and re-login identity.
  // The complete Account ID prevents two gateways with the same name colliding.
  return {
    accountId,
    gatewayId,
    alias,
    email: `${gatewayId} · ${accountId} · ${alias}`,
  };
}

export const LOGIN_PROMPTS = [
  {
    type: "text",
    key: "accountId",
    message: "Cloudflare Account ID",
    placeholder: "32 hexadecimal characters",
    validate: (value) =>
      typeof value === "string" && ACCOUNT_ID.test(value.trim())
        ? undefined
        : "Enter a 32-character Cloudflare Account ID",
  },
  {
    type: "text",
    key: "gatewayId",
    message: "AI Gateway ID",
    placeholder: "my-gateway",
    validate: (value) =>
      typeof value === "string" &&
      value.trim().length <= 64 &&
      GATEWAY_ID.test(value.trim())
        ? undefined
        : "Enter the Gateway ID from Cloudflare",
  },
  {
    type: "text",
    key: "alias",
    message: "BYOK key alias (optional)",
    placeholder: "default",
    validate: (value) =>
      typeof value !== "string" || !value.trim() || ALIAS.test(value.trim())
        ? undefined
        : "Enter an alias or leave empty for default",
  },
];

export function authorize(inputs) {
  try {
    return { type: "success", metadata: loginMetadata(inputs) };
  } catch (error) {
    return { type: "failed", error: error.message };
  }
}

export function accountOf(auth) {
  // Magpie stores the pasted token verbatim and never shows it to authorize().
  const token = typeof auth?.key === "string" ? auth.key.trim() : "";
  if (auth?.type !== "api" || !token || /[^\x21-\x7e]/.test(token)) {
    throw Object.assign(new Error("Sign in with a Cloudflare API token"), {
      signIn: "expired",
    });
  }
  let metadata;
  try {
    metadata = loginMetadata(auth.metadata);
  } catch {
    throw Object.assign(
      new Error(
        "This account has no valid Gateway settings; sign in again and complete the form",
      ),
      { signIn: "expired" },
    );
  }
  return { ...metadata, token };
}
