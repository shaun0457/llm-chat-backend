import { describe, expect, it } from "vitest";

import { pgErrorCode } from "../../src/db/errors.js";

describe("pgErrorCode", () => {
  it("reads the SQLSTATE from the error or a wrapped cause", () => {
    expect(pgErrorCode({ code: "57014" })).toBe("57014");
    expect(pgErrorCode(new Error("query failed", { cause: { code: "42P01" } }))).toBe("42P01");
  });

  it("is undefined for errors without a code", () => {
    expect(pgErrorCode(new Error("plain"))).toBeUndefined();
    expect(pgErrorCode("not an error")).toBeUndefined();
  });

  it("stops on a cause chain that loops back on itself", () => {
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    first.cause = second;

    expect(pgErrorCode(first)).toBeUndefined();
  });
});
