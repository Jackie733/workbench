import { describe, expect, test } from "bun:test";
import { ApiClientError } from "../../src/web/api.ts";
import { isRequirementNotFoundError } from "../../src/web/queries.ts";

describe("isRequirementNotFoundError", () => {
  test("returns true only for ApiClientError with code not_found", () => {
    expect(isRequirementNotFoundError(new ApiClientError("not_found", "Requirement missing"))).toBe(true);
  });

  test("returns false for transient node update conflicts and generic errors", () => {
    expect(
      isRequirementNotFoundError(
        new ApiClientError("revision_conflict", "Node update in progress or requires repair; work is paused"),
      ),
    ).toBe(false);
    expect(isRequirementNotFoundError(new ApiClientError("execution_failed", "Node offline"))).toBe(false);
    expect(isRequirementNotFoundError(new Error("Network error"))).toBe(false);
    expect(isRequirementNotFoundError(null)).toBe(false);
    expect(isRequirementNotFoundError(undefined)).toBe(false);
  });
});
