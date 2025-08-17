/**
 * Base file system classes for browser-use agent
 */

import { promises as fs, writeFileSync } from 'fs';
import path from 'path';

export const INVALID_FILENAME_ERROR_MESSAGE =
  'Error: Invalid filename format. Must be alphanumeric with supported extension.';
export const DEFAULT_FILE_SYSTEM_PATH = 'browseruse_agent_data';

/**
 * Custom exception for file system operations that should be shown to LLM
 */
export class FileSystemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileSystemError';
  }
}

/**
 * Base abstract class for all file types
 */
export abstract class BaseFile {
  name: string;
  content: string;

  constructor(name: string, content: string = '') {
    this.name = name;
    this.content = content;
  }

  /**
   * File extension (e.g. 'txt', 'md') - must be implemented by subclasses
   */
  abstract get extension(): string;

  /**
   * Update internal content (formatted)
   */
  writeFileContent(content: string): void {
    this.updateContent(content);
  }

  /**
   * Append content to internal content
   */
  appendFileContent(content: string): void {
    this.updateContent(this.content + content);
  }

  /**
   * Update internal content
   */
  updateContent(content: string): void {
    this.content = content;
  }

  /**
   * Synchronously write to disk
   */
  syncToDiskSync(dirPath: string): void {
    const filePath = path.join(dirPath, this.fullName);
    writeFileSync(filePath, this.content, 'utf-8');
  }

  /**
   * Asynchronously write to disk
   */
  async syncToDisk(dirPath: string): Promise<void> {
    const filePath = path.join(dirPath, this.fullName);
    await fs.writeFile(filePath, this.content, 'utf-8');
  }

  /**
   * Write content and sync to disk
   */
  async write(content: string, dirPath: string): Promise<void> {
    this.writeFileContent(content);
    await this.syncToDisk(dirPath);
  }

  /**
   * Append content and sync to disk
   */
  async append(content: string, dirPath: string): Promise<void> {
    this.appendFileContent(content);
    await this.syncToDisk(dirPath);
  }

  /**
   * Read content
   */
  read(): string {
    return this.content;
  }

  /**
   * Get full filename with extension
   */
  get fullName(): string {
    return `${this.name}.${this.extension}`;
  }

  /**
   * Get content size in characters
   */
  get size(): number {
    return this.content.length;
  }

  /**
   * Get line count
   */
  get lineCount(): number {
    return this.content.split('\n').length;
  }

  /**
   * Serialize to plain object
   */
  toJSON(): { name: string; content: string } {
    return {
      name: this.name,
      content: this.content,
    };
  }

  /**
   * Create from plain object
   */
  static fromJSON(
    data: { name: string; content: string },
    FileClass: typeof BaseFile
  ): BaseFile {
    return new (FileClass as any)(data.name, data.content);
  }
}

/**
 * Markdown file implementation
 */
export class MarkdownFile extends BaseFile {
  get extension(): string {
    return 'md';
  }
}

/**
 * Plain text file implementation
 */
export class TxtFile extends BaseFile {
  get extension(): string {
    return 'txt';
  }
}

/**
 * JSON file implementation
 */
export class JsonFile extends BaseFile {
  get extension(): string {
    return 'json';
  }
}

/**
 * CSV file implementation
 */
export class CsvFile extends BaseFile {
  get extension(): string {
    return 'csv';
  }
}

/**
 * PDF file implementation
 * Note: For PDF generation, we would need additional libraries like puppeteer or pdf-lib
 * For now, this is a basic implementation that stores markdown content
 */
export class PdfFile extends BaseFile {
  get extension(): string {
    return 'pdf';
  }

  /**
   * PDF files require special handling for disk sync
   * For now, we'll save as text content until PDF generation is implemented
   */
  async syncToDisk(dirPath: string): Promise<void> {
    try {
      // For now, save as text content
      // TODO: Implement proper PDF generation using puppeteer or similar
      const filePath = path.join(dirPath, `${this.name}.txt`); // Temporary: save as .txt
      await fs.writeFile(filePath, this.content, 'utf-8');
    } catch (error) {
      throw new FileSystemError(
        `Error: Could not write to file '${this.fullName}'. ${(error as Error).message}`
      );
    }
  }

  syncToDiskSync(dirPath: string): void {
    try {
      // For now, save as text content
      // TODO: Implement proper PDF generation
      const filePath = path.join(dirPath, `${this.name}.txt`); // Temporary: save as .txt
      writeFileSync(filePath, this.content, 'utf-8');
    } catch (error) {
      throw new FileSystemError(
        `Error: Could not write to file '${this.fullName}'. ${(error as Error).message}`
      );
    }
  }
}
