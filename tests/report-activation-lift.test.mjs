import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeActivationLift,
  fetchTable,
  formatActivationLiftReport,
  indexFeatureRows,
} from "../scripts/report-activation-lift.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 25);
const WINDOW_MS = 14 * DAY_MS;

function emptyFeatureRows() {
  return {
    notificationChannels: [],
    alertRules: [],
    userApiKeys: [],
    mcpProTokens: [],
  };
}

test("fetchTable bounds a hung Convex export and reports the table", () => {
  const timeout = Object.assign(new Error("spawnSync npx ETIMEDOUT"), { code: "ETIMEDOUT" });
  assert.throws(
    () => fetchTable("alertRules", {
      limit: 20_000,
      timeoutMs: 1234,
      runner: () => ({
        error: timeout,
        status: null,
        signal: "SIGTERM",
        stdout: "",
        stderr: "",
      }),
    }),
    /alertRules timed out after 1234ms/,
  );
});

test("fetchTable marks a cap hit instead of treating a newest-first slice as complete", () => {
  const result = fetchTable("userApiKeys", {
    limit: 2,
    runner: () => ({
      status: 0,
      signal: null,
      stdout: '{"userId":"a"}\n{"userId":"b"}\n',
      stderr: "",
    }),
  });
  assert.equal(result.truncated, true);
  assert.equal(result.rows.length, 2);
});

test("analysis uses only mature presentations and table-specific adoption timestamps", () => {
  const observationStartedAt = NOW - WINDOW_MS;
  const presentedBeforeExit = observationStartedAt - DAY_MS;
  const presentations = [
    {
      userId: "engaged",
      presentedAt: presentedBeforeExit,
      confirmedSteps: ["brief"],
      exitedAt: observationStartedAt,
    },
    {
      userId: "presented-only",
      presentedAt: observationStartedAt,
      confirmedSteps: [],
      // Deliberately no exitedAt: lost exits stay in the cohort.
    },
    {
      userId: "immature",
      presentedAt: NOW - WINDOW_MS + 1,
      confirmedSteps: ["brief"],
    },
    {
      userId: "progress-immature",
      presentedAt: presentedBeforeExit,
      confirmedSteps: ["brief"],
      outcomeUpdatedAt: NOW - WINDOW_MS + 1,
    },
  ];
  const featureRowsByTable = {
    ...emptyFeatureRows(),
    notificationChannels: [
      {
        userId: "engaged",
        verified: true,
        // Existing row re-verified at the inclusive end boundary.
        linkedAt: observationStartedAt + WINDOW_MS,
        _creationTime: observationStartedAt - 100 * DAY_MS,
      },
      {
        userId: "presented-only",
        verified: false,
        linkedAt: observationStartedAt + DAY_MS,
      },
    ],
    alertRules: [
      {
        userId: "presented-only",
        enabled: true,
        // Existing rule updated just outside the observation window.
        updatedAt: observationStartedAt + WINDOW_MS + 1,
        _creationTime: observationStartedAt - 100 * DAY_MS,
      },
    ],
    userApiKeys: [
      {
        userId: "engaged",
        // A row created inside the wizard, before exit, is not downstream adoption.
        createdAt: presentedBeforeExit + 1,
      },
    ],
  };

  const analysis = analyzeActivationLift({
    presentations,
    featureRowsByTable,
    reportNow: NOW,
    windowMs: WINDOW_MS,
    minGroupSize: 1,
  });

  assert.equal(analysis.verdict, "comparison");
  assert.equal(analysis.mature, 2);
  assert.equal(analysis.immature, 2);
  assert.equal(analysis.incompleteExits, 1);
  assert.deepEqual(analysis.engaged, {
    n: 1,
    anyCount: 1,
    rate: 1,
    perTable: {
      notificationChannels: 1,
      alertRules: 0,
      userApiKeys: 0,
      mcpProTokens: 0,
    },
  });
  assert.equal(analysis.presentedOnly.anyCount, 0);
  assert.equal(analysis.lift, 1);
});

test("analysis refuses capped exports before rates and enforces the mature sample floor", () => {
  const presentations = Array.from({ length: 59 }, (_, index) => ({
    userId: `user-${index}`,
    presentedAt: NOW - WINDOW_MS,
    confirmedSteps: index < 29 ? ["brief"] : [],
  }));

  const capped = analyzeActivationLift({
    presentations,
    featureRowsByTable: emptyFeatureRows(),
    truncatedTables: ["alertRules"],
    reportNow: NOW,
    windowMs: WINDOW_MS,
  });
  assert.equal(capped.verdict, "incomplete-export");
  assert.equal(capped.engaged, null);
  assert.match(
    formatActivationLiftReport(capped, { windowDays: 14, limit: 20_000 }),
    /Inconclusive.*alertRules.*no adoption rates were computed/s,
  );

  const complete = analyzeActivationLift({
    presentations,
    featureRowsByTable: emptyFeatureRows(),
    reportNow: NOW,
    windowMs: WINDOW_MS,
  });
  assert.equal(complete.engaged.n, 29);
  assert.equal(complete.presentedOnly.n, 30);
  assert.equal(complete.verdict, "below-sample-floor");
});

test("feature indexing performs one pass and excludes inactive credentials", () => {
  const featureRows = emptyFeatureRows();
  featureRows.userApiKeys = Array.from({ length: 20_000 }, (_, index) => ({
    userId: `user-${index}`,
    createdAt: index,
    ...(index % 2 === 0 ? {} : { revokedAt: index + 1 }),
  }));
  const index = indexFeatureRows(featureRows);
  assert.deepEqual(index.userApiKeys.get("user-0"), [0]);
  assert.equal(index.userApiKeys.has("user-1"), false);
  assert.equal(index.userApiKeys.size, 10_000);
});
