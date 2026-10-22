/** What admission needs to know about the provider of a turn. */
export type ProviderMeta = Readonly<{ id: string; requiresKey: boolean }>;

/** Operator keys from the environment, by provider id. Secrets: never log them. */
export type OperatorKeys = Readonly<Record<string, string>>;

export type CredentialDecision = { key: string | null } | { rejected: "llm_credential_missing" };

/**
 * The key for one new send or retry, decided once at admission: the request's header, else
 * the operator's key for this provider, else none for a keyless provider, else rejected.
 * The header has already been validated by the route schema.
 */
export function decideCredential(
  headerKey: string | undefined,
  provider: ProviderMeta,
  operatorKeys: OperatorKeys,
): CredentialDecision {
  if (headerKey !== undefined) {
    return { key: headerKey };
  }
  const operatorKey = Object.hasOwn(operatorKeys, provider.id)
    ? operatorKeys[provider.id]
    : undefined;
  if (operatorKey !== undefined) {
    return { key: operatorKey };
  }
  return provider.requiresKey ? { rejected: "llm_credential_missing" } : { key: null };
}
