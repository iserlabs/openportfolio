import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/backup-scheduler", () => ({ registerBackupScheduler: vi.fn() }));

import { registerBackupScheduler } from "./lib/backup-scheduler";
import { register } from "./instrumentation";

describe("instrumentation register()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to registerBackupScheduler in the Node runtime", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    try {
      await register();
      expect(registerBackupScheduler).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.NEXT_RUNTIME;
    }
  });

  it("does nothing outside the Node runtime -- never even imports the Node-only scheduler module", async () => {
    process.env.NEXT_RUNTIME = "edge";
    try {
      await register();
      expect(registerBackupScheduler).not.toHaveBeenCalled();
    } finally {
      delete process.env.NEXT_RUNTIME;
    }
  });

  it("does nothing when NEXT_RUNTIME is unset", async () => {
    delete process.env.NEXT_RUNTIME;
    await register();
    expect(registerBackupScheduler).not.toHaveBeenCalled();
  });
});
