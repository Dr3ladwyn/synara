import { afterEach, expect, it, vi } from "vitest";
import { DESKTOP_DIAGNOSTIC_ISSUE_PREFIX } from "@synara/contracts";
import {
  SYNARA_DESKTOP_BUNDLE_ID_ENV,
  SYNARA_BETA_BUNDLE_ID,
  SYNARA_PRODUCTION_BUNDLE_ID,
} from "@synara/shared/desktopIdentity";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

it.each([SYNARA_PRODUCTION_BUNDLE_ID, "", SYNARA_BETA_BUNDLE_ID])(
  "emits only allowlisted fields from a Beta backend (%s)",
  async (bundleId) => {
    vi.stubEnv(SYNARA_DESKTOP_BUNDLE_ID_ENV, bundleId);
    vi.resetModules();
    const { reportBetaOperationalIssue } = await import("./betaOperationalIssue");
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const issue = {
      code: "git.commit.failed" as const,
      reason: "output-limit" as const,
      privateText: "never emit",
    };
    reportBetaOperationalIssue(issue);
    const calls = write.mock.calls.slice();
    write.mockRestore();
    if (bundleId === SYNARA_BETA_BUNDLE_ID) {
      expect(calls).toEqual([
        [
          DESKTOP_DIAGNOSTIC_ISSUE_PREFIX +
            '{"code":"git.commit.failed","reason":"output-limit"}\n',
        ],
      ]);
    } else expect(calls).toEqual([]);
  },
);
