/**
 * Browser profiles module exports
 */

export { BrowserProfile } from './browser-profile';
export type { ProfileBuildResult } from './browser-profile';

export { ExtensionManager, DEFAULT_EXTENSIONS } from './extensions';

export {
  getSystemInfo,
  isDockerEnvironment,
  hasDisplayAvailable,
  getWindowAdjustments
} from './environment';
export type { SystemInfo } from './environment';

export {
  CHROME_OPTIMIZED_ARGS,
  CHROME_DOCKER_ARGS,
  CHROME_HEADLESS_ARGS,
  CHROME_DISABLE_SECURITY_ARGS,
  CHROME_DETERMINISTIC_RENDERING_ARGS,
  CHROME_STEALTH_ARGS,
  CHROME_EXTENSION_ARGS,
  CHROME_DISABLED_COMPONENTS,
  CHROME_DEBUG_PORT,
} from './chrome-args';

export {
  PRESETS,
  getPreset,
  createCustomConfig,
  DEFAULT_PRESET,
  OPTIMIZED_PRESET,
  DEVELOPMENT_PRESET,
  TESTING_PRESET,
  PRODUCTION_PRESET,
  DOCKER_PRESET,
  STEALTH_PRESET,
} from './presets';
export type { PresetName } from './presets';
