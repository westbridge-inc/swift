/**
 * Repeatable jobs that no longer exist. A repeatable registration lives in Redis, not in the code, so a deleted job
 * keeps firing on a deployed server until a boot removes it. Idempotent: a boot with nothing to retire removes nothing.
 *
 * rlp-reserve-provision: [Coordinator ruling, 5 Nov 2026] set aside a share of paid fees each month. Fee money must
 * not feed what Swift may pay at its discretion.
 */
export const RETIRED_SCHEDULES: readonly string[] = ['rlp-reserve-provision'];

interface RepeatableQueue {
  getRepeatableJobs(): Promise<Array<{ name: string; key: string }>>;
  removeRepeatableByKey(key: string): Promise<boolean>;
}

export async function removeRetiredSchedules(queue: RepeatableQueue): Promise<void> {
  for (const job of await queue.getRepeatableJobs()) {
    if (RETIRED_SCHEDULES.includes(job.name)) await queue.removeRepeatableByKey(job.key);
  }
}
