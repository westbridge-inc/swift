import {
  samePrincipalBoundary,
  type AuthPrincipalBoundary,
} from './authSession';

/** An omitted owner is an intentional unconditional stop (for the current
 * controller). A captured logout owner may retire only its own generation. */
export function canTeardownRuntime(
  currentOwner: AuthPrincipalBoundary | null,
  expectedOwner?: AuthPrincipalBoundary,
): boolean {
  return expectedOwner === undefined
    || samePrincipalBoundary(currentOwner, expectedOwner);
}

/** FIFO for process-global native resources whose start/stop operations await.
 * The rejection branch also advances the tail so one native failure cannot
 * permanently deadlock future account ownership changes. */
export class SerializedRuntimeLifecycle {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
