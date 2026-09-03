/**
 * The platform SPINE, re-exported from src so the seed scripts, the demo seed
 * and the tests share ONE module. The data, the version and the plan
 * orchestration live in src/modules/ops/platform-config.ts ([R048-005]);
 * this file holds no schema DDL and no values of its own.
 */
export { PLATFORM_CONFIG_VERSION, desiredPlatformConfig, guyanaTiers, seedPlatformSpine, type SpineOptions } from '../src/modules/ops/platform-config';
