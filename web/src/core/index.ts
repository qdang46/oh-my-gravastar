/**
 * `web/src/core/` — capability-aware device layer.
 *
 * Library-only for now: pages are not wired to it yet (bead
 * oh-my-gravastar-zlb). Import surface:
 *
 * - `device-model.ts` — `DeviceLike`, `DetectedDevice`, `detectDevice()`
 * - `capabilities.ts`  — `CapabilityMap`, `getCapabilities()`
 * - `feature-registry.ts` — `FEATURE_REGISTRY`, `isFeatureAvailable()`,
 *   `describeFeature()`
 * - `compatibility.ts` — `canApplyProfile()`
 */

export * from './device-model.ts';
export * from './capabilities.ts';
export * from './feature-registry.ts';
export * from './compatibility.ts';
