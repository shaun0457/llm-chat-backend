import { describe, expect, it } from "vitest";

import { decideCredential } from "../../src/credentials/decide.js";

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

  it("needs no key for a keyless provider", () => {
    expect(decideCredential(undefined, keyless, {})).toEqual({ key: null });
  });

  it("still passes a header key on to a keyless provider", () => {
    expect(decideCredential("from-header", keyless, {})).toEqual({ key: "from-header" });
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
