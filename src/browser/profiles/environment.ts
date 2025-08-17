/**
 * Environment detection utilities for browser configuration
 */

import os from 'os';
import { existsSync } from 'fs';

export interface SystemInfo {
  platform: 'darwin' | 'win32' | 'linux' | 'unknown';
  isDocker: boolean;
  hasDisplay: boolean;
  architecture: string;
  homeDir: string;
}

/**
 * Detect if running inside Docker container
 */
export function isDockerEnvironment(): boolean {
  try {
    // Check for Docker-specific files and environment variables
    const dockerIndicators = ['/.dockerenv', '/proc/self/cgroup'];

    // Check for Docker files
    for (const indicator of dockerIndicators) {
      if (existsSync(indicator)) {
        return true;
      }
    }

    // Check environment variables
    if (process.env.DOCKER || process.env.CONTAINER) {
      return true;
    }

    // Check hostname pattern (common in Docker)
    const hostname = os.hostname();
    if (hostname.length === 12 && /^[a-f0-9]{12}$/.test(hostname)) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Detect if display is available (for headful mode)
 */
export function hasDisplayAvailable(): boolean {
  const platform = os.platform();

  switch (platform) {
    case 'darwin': // macOS
      return true; // macOS always has display in normal environments

    case 'win32': // Windows
      return true; // Windows always has display in normal environments

    case 'linux':
      // Check for X11 or Wayland display
      return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

    default:
      return false;
  }
}

/**
 * Get system information for configuration
 */
export function getSystemInfo(): SystemInfo {
  const platform = os.platform() as SystemInfo['platform'];

  return {
    platform: ['darwin', 'win32', 'linux'].includes(platform)
      ? platform
      : 'unknown',
    isDocker: isDockerEnvironment(),
    hasDisplay: hasDisplayAvailable(),
    architecture: os.arch(),
    homeDir: os.homedir(),
  };
}

/**
 * Get recommended window adjustments for different platforms
 */
export function getWindowAdjustments(): { x: number; y: number } {
  const platform = os.platform();

  switch (platform) {
    case 'darwin': // macOS
      return { x: -4, y: 24 }; // macOS has small title bar, no border

    case 'win32': // Windows
      return { x: -8, y: 0 }; // Windows has border on the left

    default: // Linux and others
      return { x: 0, y: 0 };
  }
}
