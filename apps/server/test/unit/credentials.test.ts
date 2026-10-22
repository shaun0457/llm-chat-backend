import { describe, expect, it } from "vitest";

import { type OperatorKeys, decideCredential } from "../../src/credentials/decide.js";

const keyed = { id: "hosted", requiresKey: true };
const keyless = { id: "local", requiresKey: false };

describe("decideCredential", () => {
  it("uses the request header over the operator key", () => {
    expect(decideCredential("from-header", keyed, { hosted: "from-env" })).toEqual({
      key: "from-header",
    });
  });

  it("uses the operator key of that provider when no header was sent", () => {
    expect(decideCredential(undefined, keyed, { hosted: "from-env", other: "x" })).toEqual({
      key: "from-env",
    });
  });

  it.each<[string, string | undefined, OperatorKeys]>([
    ["neither a header nor an operator key", undefined, {}],
    ["a header key", "from-header", {}],
    ["an operator key", undefined, { local: "from-env" }],
    ["both", "from-header", { local: "from-env" }],
  ])("never gives a keyless provider a key, with %s (#33)", (_label, header, operator) => {
    expect(decideCredential(header, keyless, operator)).toEqual({ key: null });
  });

  it("rejects a provider that needs a key when there is none", () => {
    expect(decideCredential(undefined, keyed, { other: "not-this-one" })).toEqual({
      rejected: "llm_credential_missing",
    });
  });

  it("never takes an inherited property for an operator key", () => {
    expect(decideCredential(undefined, { id: "toString", requiresKey: true }, {})).toEqual({
      rejected: "llm_credential_missing",
    });
  });
});
