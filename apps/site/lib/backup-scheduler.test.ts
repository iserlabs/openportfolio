import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./backup", () => ({ runBackup: vi.fn() }));
vi.mock("./oauth", () => ({ pruneOauthStates: vi.fn() }));

import { runBackup } from "./backup";
import { pruneOauthStates } from "./oauth";
import { registerBackupScheduler } from "./backup-scheduler";

const REGISTERED_FLAG = "__openPortfolioBackupSchedulerRegistered";
const FIRST_RUN_DELAY_MS = 60 * 1000;
const TICK_MS = 24 * 60 * 60 * 1000;

describe("registerBackupScheduler()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    delete (globalThis as Record<string, unknown>)[REGISTERED_FLAG];
    vi.mocked(runBackup).mockResolvedValue({ skipped: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.BACKUP_DIR;
    delete (globalThis as Record<string, unknown>)[REGISTERED_FLAG];
  });

  it("always prunes oauth_states every tick, even with BACKUP_DIR unset -- the CAR/blob half no-ops on its own via runBackup's {skipped:true}", () => {
    delete process.env.BACKUP_DIR;

    registerBackupScheduler();
    vi.advanceTimersByTime(FIRST_RUN_DELAY_MS);

    expect(runBackup).toHaveBeenCalledTimes(1);
    expect(pruneOauthStates).toHaveBeenCalledTimes(1);
    expect(pruneOauthStates).toHaveBeenCalledWith(60 * 60 * 1000);
  });

  it("registers the timer even without BACKUP_DIR set -- registration is unconditional", () => {
    delete process.env.BACKUP_DIR;

    registerBackupScheduler();
    vi.advanceTimersByTime(FIRST_RUN_DELAY_MS);

    // runBackup was still called (it's the one that no-ops internally);
    // the scheduler itself never skips registering.
    expect(runBackup).toHaveBeenCalledTimes(1);
  });

  it("runs the first tick 60s after boot, then every 24h thereafter", () => {
    registerBackupScheduler();

    expect(runBackup).not.toHaveBeenCalled();
    expect(pruneOauthStates).not.toHaveBeenCalled();

    vi.advanceTimersByTime(FIRST_RUN_DELAY_MS);
    expect(runBackup).toHaveBeenCalledTimes(1);
    expect(pruneOauthStates).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(TICK_MS);
    expect(runBackup).toHaveBeenCalledTimes(2);
    expect(pruneOauthStates).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(TICK_MS);
    expect(runBackup).toHaveBeenCalledTimes(3);
    expect(pruneOauthStates).toHaveBeenCalledTimes(3);
  });

  it("guards against double registration -- a second call schedules nothing extra", () => {
    registerBackupScheduler();
    registerBackupScheduler(); // simulates Next dev's hot-reload re-invoking register()

    vi.advanceTimersByTime(FIRST_RUN_DELAY_MS);
    expect(runBackup).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(TICK_MS);
    expect(runBackup).toHaveBeenCalledTimes(2);
  });

  it("a pruneOauthStates throw is logged, not left to crash the tick", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(pruneOauthStates).mockImplementationOnce(() => {
      throw new Error("db locked");
    });

    registerBackupScheduler();
    expect(() => vi.advanceTimersByTime(FIRST_RUN_DELAY_MS)).not.toThrow();

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("pruneOauthStates"),
      expect.stringContaining("db locked"),
    );
  });
});
