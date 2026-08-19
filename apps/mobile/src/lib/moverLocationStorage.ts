export const MOVER_LOCATION_LEGACY_SECURE_STORE_KEY = 'swift.moverLocation.backgroundSession.v1';
export const MOVER_LOCATION_SESSION_MMKV_KEY = 'swift.moverLocation.backgroundSession.v2';
export const MOVER_LOCATION_MIGRATION_MARKER_KEY = 'swift.moverLocation.storageMigrated.v2';

export interface MoverLocationStorageDependencies {
  initialize: () => Promise<void>;
  getValue: (key: string) => string | null | Promise<string | null>;
  setValue: (key: string, value: string) => unknown | Promise<unknown>;
  removeValue: (key: string) => unknown | Promise<unknown>;
  readLegacy: () => Promise<string | null>;
  deleteLegacy: () => Promise<void>;
}

/** High-frequency location checkpoints belong in the existing encrypted MMKV,
 * not Keychain/Keystore. The marker makes legacy migration crash-safe: a
 * process never trusts the copied record until the old SecureStore value was
 * successfully removed, and a failed migration is retried on the next call. */
export function createMoverLocationDurableStorage(
  dependencies: MoverLocationStorageDependencies,
) {
  let migration: Promise<void> | null = null;

  const ensureMigrated = async (): Promise<void> => {
    migration ??= (async () => {
      await dependencies.initialize();
      const migrated = await dependencies.getValue(MOVER_LOCATION_MIGRATION_MARKER_KEY);
      if (migrated === '1') return;

      const legacy = await dependencies.readLegacy();
      if (legacy) {
        const current = await dependencies.getValue(MOVER_LOCATION_SESSION_MMKV_KEY);
        // A crash may have copied the record before deleting SecureStore. Keep
        // the existing MMKV value if present; it can be newer than legacy.
        if (!current) {
          await dependencies.setValue(MOVER_LOCATION_SESSION_MMKV_KEY, legacy);
        }
        await dependencies.deleteLegacy();
      }
      await dependencies.setValue(MOVER_LOCATION_MIGRATION_MARKER_KEY, '1');
    })();

    try {
      await migration;
    } catch (error) {
      migration = null;
      throw error;
    }
  };

  return {
    async read(): Promise<string | null> {
      await ensureMigrated();
      return dependencies.getValue(MOVER_LOCATION_SESSION_MMKV_KEY);
    },
    async write(raw: string): Promise<void> {
      await ensureMigrated();
      await dependencies.setValue(MOVER_LOCATION_SESSION_MMKV_KEY, raw);
    },
    async delete(): Promise<void> {
      await ensureMigrated();
      await dependencies.removeValue(MOVER_LOCATION_SESSION_MMKV_KEY);
    },
  };
}
