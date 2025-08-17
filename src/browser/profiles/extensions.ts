/**
 * Browser extension management
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import { existsSync, createWriteStream } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { ExtensionConfig } from '../../types/browser';
import { getLogger } from '../../services/logging';

const execAsync = promisify(exec);

/**
 * Default automation-optimized extensions
 */
export const DEFAULT_EXTENSIONS: ExtensionConfig[] = [
  {
    id: 'cjpalhdlnbpafiamejdnhcphjbkeiagm', // uBlock Origin
    name: 'uBlock Origin',
    enabled: true,
  },
  {
    id: 'edibdbjcniadpccecjdfdjjppcpchdlm', // I still don't care about cookies
    name: "I still don't care about cookies",
    enabled: true,
  },
  {
    id: 'lckanjgmijmafbedllaakclkaicjfmnk', // ClearURLs
    name: 'ClearURLs',
    enabled: true,
  },
];

/**
 * Extension manager for handling Chrome extensions
 */
export class ExtensionManager {
  private cacheDir: string;

  constructor(cacheDir?: string) {
    this.cacheDir =
      cacheDir || path.join(os.homedir(), '.browser-use', 'extensions');
  }

  /**
   * Ensure cache directory exists
   */
  private async ensureCacheDir(): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
    } catch (error) {
      getLogger().warn(`Failed to create extension cache directory: ${error}`);
    }
  }

  /**
   * Download extension from Chrome Web Store
   */
  private async downloadExtension(extensionId: string): Promise<string> {
    const crxUrl = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=130&acceptformat=crx3&x=id%3D${extensionId}%26uc`;
    const crxPath = path.join(this.cacheDir, `${extensionId}.crx`);

    if (existsSync(crxPath)) {
      return crxPath;
    }

    getLogger().info(`Downloading extension ${extensionId}...`);

    return new Promise((resolve, reject) => {
      https
        .get(crxUrl, (response) => {
          if (response.statusCode !== 200) {
            reject(
              new Error(`Failed to download extension: ${response.statusCode}`)
            );
            return;
          }

          const writeStream = createWriteStream(crxPath);
          response.pipe(writeStream);

          writeStream.on('finish', () => {
            writeStream.close();
            resolve(crxPath);
          });

          writeStream.on('error', (error) => {
            reject(error);
          });
        })
        .on('error', (error) => {
          reject(error);
        });
    });
  }

  /**
   * Extract CRX file to directory
   */
  private async extractExtension(
    crxPath: string,
    extensionId: string
  ): Promise<string> {
    const extractDir = path.join(this.cacheDir, extensionId);

    // Remove existing directory
    if (existsSync(extractDir)) {
      await fs.rm(extractDir, { recursive: true, force: true });
    }

    await fs.mkdir(extractDir, { recursive: true });

    try {
      // Try system unzip first (works for most CRX files)
      await execAsync(`unzip -q "${crxPath}" -d "${extractDir}"`);

      // Verify manifest exists
      const manifestPath = path.join(extractDir, 'manifest.json');
      if (!existsSync(manifestPath)) {
        throw new Error('No manifest.json found after extraction');
      }

      return extractDir;
    } catch (error) {
      // If unzip fails, try to handle CRX header manually
      getLogger().warn(
        `System unzip failed for ${extensionId}, trying manual CRX extraction: ${error}`
      );

      try {
        const data = await fs.readFile(crxPath);

        // Check CRX magic number
        if (data.slice(0, 4).toString() !== 'Cr24') {
          throw new Error('Invalid CRX format');
        }

        // Parse CRX header to find ZIP data start
        const version = data.readUInt32LE(4);
        let zipStart = 16; // Default for CRX2

        if (version === 3) {
          const headerLength = data.readUInt32LE(8);
          zipStart = 12 + headerLength;
        } else if (version === 2) {
          const pubKeyLength = data.readUInt32LE(8);
          const sigLength = data.readUInt32LE(12);
          zipStart = 16 + pubKeyLength + sigLength;
        }

        // Extract ZIP data and save to temp file
        const zipData = data.slice(zipStart);
        const tempZipPath = crxPath + '.zip';
        await fs.writeFile(tempZipPath, zipData);

        // Try unzip on the extracted ZIP data
        await execAsync(`unzip -q "${tempZipPath}" -d "${extractDir}"`);

        // Clean up temp file
        await fs.unlink(tempZipPath);

        // Verify manifest exists
        const manifestPath = path.join(extractDir, 'manifest.json');
        if (!existsSync(manifestPath)) {
          throw new Error('No manifest.json found after CRX extraction');
        }

        return extractDir;
      } catch (extractError) {
        getLogger().error(
          `Failed to extract extension ${extensionId}: ${extractError}`
        );
        throw extractError;
      }
    }
  }

  /**
   * Setup a single extension
   */
  private async setupExtension(
    extension: ExtensionConfig
  ): Promise<string | null> {
    if (!extension.enabled) {
      return null;
    }

    await this.ensureCacheDir();

    try {
      // If path is provided, use it directly
      if (extension.path) {
        const manifestPath = path.join(extension.path, 'manifest.json');
        if (existsSync(manifestPath)) {
          getLogger().info(
            `Using local extension: ${extension.name || extension.path}`
          );
          return extension.path;
        } else {
          getLogger().warn(
            `Local extension path does not contain manifest.json: ${extension.path}`
          );
          return null;
        }
      }

      // Download and extract from Chrome Web Store
      if (extension.id) {
        const extractDir = path.join(this.cacheDir, extension.id);
        const manifestPath = path.join(extractDir, 'manifest.json');

        // Check if already extracted
        if (existsSync(manifestPath)) {
          getLogger().info(
            `Extension already cached: ${extension.name || extension.id}`
          );
          return extractDir;
        }

        // Download and extract
        const crxPath = await this.downloadExtension(extension.id);
        const extractedPath = await this.extractExtension(
          crxPath,
          extension.id
        );

        getLogger().info(`Extension ready: ${extension.name || extension.id}`);
        return extractedPath;
      }

      getLogger().warn(
        `Extension configuration invalid: ${JSON.stringify(extension)}`
      );
      return null;
    } catch (error) {
      getLogger().error(
        `Failed to setup extension ${extension.name || extension.id}: ${error}`
      );
      return null;
    }
  }

  /**
   * Setup multiple extensions and return paths for Chrome args
   */
  async setupExtensions(extensions: ExtensionConfig[]): Promise<string[]> {
    const promises = extensions.map((ext) => this.setupExtension(ext));
    const results = await Promise.allSettled(promises);

    const extensionPaths: string[] = [];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value) {
        extensionPaths.push(result.value);
      } else if (result.status === 'rejected') {
        getLogger().error(
          `Failed to setup extension ${extensions[index]?.name}: ${result.reason}`
        );
      }
    });

    if (extensionPaths.length > 0) {
      getLogger().info(
        `Successfully loaded ${extensionPaths.length} extensions`
      );
    }

    return extensionPaths;
  }

  /**
   * Get Chrome arguments for loading extensions
   */
  async getExtensionArgs(extensions: ExtensionConfig[]): Promise<string[]> {
    if (!extensions || extensions.length === 0) {
      return [];
    }

    const extensionPaths = await this.setupExtensions(extensions);

    if (extensionPaths.length === 0) {
      return [];
    }

    return [
      '--enable-extensions',
      '--disable-extensions-file-access-check',
      '--disable-extensions-http-throttling',
      '--enable-extension-activity-logging',
      `--load-extension=${extensionPaths.join(',')}`,
    ];
  }
}
