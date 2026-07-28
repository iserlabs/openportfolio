import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./backup", () => ({ runBackup: vi.fn() }));

import { runBackup } from "./backup";
import { registerBackupScheduler } from "./backup-scheduler";

const REGISTERED_FLAG = "__openPortfolioBackupSchedulerRegistered";
const FIRST_RUN_DELAY_MS = 60 * 1000;
const TICK_MS = 24 * 60 * 60 * 1000;

describe("registerBackupScheduler()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    delete (globalThis as Record<string, unknown>)[REGISTERED_FLAG];
    process.env.BACKUP_DIR = "/tmp/open-portfolio-backups";
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.BACKUP_DIR;
    delete (globalThis as Record<string, unknown>)[REGISTERED_FLAG];
  });

  it("does nothing when BACKUP_DIR is unset", () => {
    delete process.env.BACKUP_DIR;

    registerBackupScheduler();
    vi.advanceTimersByTime(FIRST_RUN_DELAY_MS + TICK_MS * 3);

    expect(runBackup).not.toHaveBeenCalled();
  });

  it("runs the first backup 60s after boot, then every 24h thereafter", () => {
    registerBackupScheduler();

    expect(runBackup).not.toHaveBeenCalled();

    vi.advanceTimersByTime(FIRST_RUN_DELAY_MS);
    expect(runBackup).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(TICK_MS);
    expect(runBackup).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(TICK_MS);
    expect(runBackup).toHaveBeenCalledTimes(3);
  });

  it("guards against double registration -- a second call schedules nothing extra", () => {
    registerBackupScheduler();
    registerBackupScheduler(); // simulates Next dev's hot-reload re-invoking register()

    vi.advanceTimersByTime(FIRST_RUN_DELAY_MS);
    expect(runBackup).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(TICK_MS);
    expect(runBackup).toHaveBeenCalledTimes(2);
  });
});
