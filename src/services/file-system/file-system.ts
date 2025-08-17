/**
 * Enhanced file system with in-memory storage and multiple file type support
 */

import { promises as fs, existsSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import {
  BaseFile,
  MarkdownFile,
  TxtFile,
  JsonFile,
  CsvFile,
  PdfFile,
  FileSystemError,
  INVALID_FILENAME_ERROR_MESSAGE,
  DEFAULT_FILE_SYSTEM_PATH,
} from './base-file';
import { getLogger } from '../logging';

/**
 * Serializable state of the file system
 */
export interface FileSystemState {
  files: Record<string, { type: string; data: { name: string; content: string } }>;
  baseDir: string;
  extractedContentCount: number;
}

/**
 * Enhanced file system with in-memory storage and multiple file type support
 */
export class FileSystem {
  private baseDir: string;
  private dataDir: string;
  private files: Map<string, BaseFile> = new Map();
  private extractedContentCount: number = 0;
  private logger = getLogger();

  private fileTypes: Record<string, new (name: string, content?: string) => BaseFile> = {
    md: MarkdownFile,
    txt: TxtFile,
    json: JsonFile,
    csv: CsvFile,
    pdf: PdfFile,
  };

  private defaultFiles: string[] = ['todo.md'];

  constructor(baseDir: string, createDefaultFiles: boolean = true) {
    this.baseDir = path.resolve(baseDir);
    this.dataDir = path.join(this.baseDir, DEFAULT_FILE_SYSTEM_PATH);

    // Ensure directories exist
    this.ensureDirectoriesExist();

    // Clean and recreate data directory
    this.cleanDataDirectory();

    if (createDefaultFiles) {
      this.createDefaultFiles();
    }

    this.logger.info(`FileSystem initialized at: ${this.dataDir}`);
  }

  /**
   * Get allowed file extensions
   */
  getAllowedExtensions(): string[] {
    return Object.keys(this.fileTypes);
  }

  /**
   * Get the appropriate file class for an extension
   */
  private getFileTypeClass(extension: string): (new (name: string, content?: string) => BaseFile) | null {
    return this.fileTypes[extension.toLowerCase()] || null;
  }

  /**
   * Ensure base directories exist
   */
  private ensureDirectoriesExist(): void {
    try {
      if (!existsSync(this.baseDir)) {
        mkdirSync(this.baseDir, { recursive: true });
      }
    } catch (error) {
      this.logger.error('Failed to create base directory', error as Error);
      throw new FileSystemError(`Failed to create base directory: ${(error as Error).message}`);
    }
  }

    /**
   * Clean and recreate data directory
   */
  private cleanDataDirectory(): void {
    try {
      // Remove existing data directory if it exists
      if (existsSync(this.dataDir)) {
        rmSync(this.dataDir, { recursive: true, force: true });
      }

      // Create fresh data directory
      mkdirSync(this.dataDir, { recursive: true });
    } catch (error) {
      this.logger.error('Failed to clean data directory', error as Error);
      throw new FileSystemError(`Failed to clean data directory: ${(error as Error).message}`);
    }
  }

  /**
   * Create default files
   */
  private createDefaultFiles(): void {
    for (const fullFilename of this.defaultFiles) {
      const { name, extension } = this.parseFilename(fullFilename);
      const FileClass = this.getFileTypeClass(extension);

      if (!FileClass) {
        throw new Error(`Invalid file extension '${extension}' for file '${fullFilename}'.`);
      }

      const fileObj = new FileClass(name);
      this.files.set(fullFilename, fileObj);
      fileObj.syncToDiskSync(this.dataDir);
    }
  }

  /**
   * Check if filename matches the required pattern: name.extension
   */
  private isValidFilename(fileName: string): boolean {
    const extensions = Object.keys(this.fileTypes).join('|');
    const pattern = new RegExp(`^[a-zA-Z0-9_\\-]+\\.(${extensions})$`);
    return pattern.test(fileName);
  }

  /**
   * Parse filename into name and extension
   */
  private parseFilename(filename: string): { name: string; extension: string } {
    if (!this.isValidFilename(filename)) {
      throw new Error(`Invalid filename: ${filename}`);
    }

    const lastDotIndex = filename.lastIndexOf('.');
    const name = filename.substring(0, lastDotIndex);
    const extension = filename.substring(lastDotIndex + 1).toLowerCase();

    return { name, extension };
  }

  /**
   * Get the file system directory
   */
  getDir(): string {
    return this.dataDir;
  }

  /**
   * Get a file object by full filename
   */
  getFile(fullFilename: string): BaseFile | null {
    if (!this.isValidFilename(fullFilename)) {
      return null;
    }
    return this.files.get(fullFilename) || null;
  }

  /**
   * List all files in the system
   */
  listFiles(): string[] {
    return Array.from(this.files.values()).map(file => file.fullName);
  }

  /**
   * Display file content
   */
  displayFile(fullFilename: string): string | null {
    if (!this.isValidFilename(fullFilename)) {
      return null;
    }

    const fileObj = this.getFile(fullFilename);
    if (!fileObj) {
      return null;
    }

    return fileObj.read();
  }

  /**
   * Read file content and return appropriate message to LLM
   */
  async readFile(fullFilename: string, externalFile: boolean = false): Promise<string> {
    if (externalFile) {
      try {
        const { extension } = this.parseFilename(fullFilename);

        if (['md', 'txt', 'json', 'csv'].includes(extension)) {
          const content = await fs.readFile(fullFilename, 'utf-8');
          return `Read from file ${fullFilename}.\n<content>\n${content}\n</content>`;
        } else if (extension === 'pdf') {
          // TODO: Implement PDF reading with a PDF library like pdf-parse
          return `Error: PDF reading not yet implemented for external files.`;
        } else {
          return `Error: Cannot read file ${fullFilename} as ${extension} extension is not supported.`;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return `Error: File '${fullFilename}' not found.`;
        } else if ((error as NodeJS.ErrnoException).code === 'EACCES') {
          return `Error: Permission denied to read file '${fullFilename}'.`;
        } else {
          return `Error: Could not read file '${fullFilename}'.`;
        }
      }
    }

    if (!this.isValidFilename(fullFilename)) {
      return INVALID_FILENAME_ERROR_MESSAGE;
    }

    const fileObj = this.getFile(fullFilename);
    if (!fileObj) {
      return `File '${fullFilename}' not found.`;
    }

    try {
      const content = fileObj.read();
      return `Read from file ${fullFilename}.\n<content>\n${content}\n</content>`;
    } catch (error) {
      if (error instanceof FileSystemError) {
        return error.message;
      }
      return `Error: Could not read file '${fullFilename}'.`;
    }
  }

  /**
   * Write content to file using file-specific write method
   */
  async writeFile(fullFilename: string, content: string): Promise<string> {
    if (!this.isValidFilename(fullFilename)) {
      return INVALID_FILENAME_ERROR_MESSAGE;
    }

    try {
      const { name, extension } = this.parseFilename(fullFilename);
      const FileClass = this.getFileTypeClass(extension);

      if (!FileClass) {
        throw new Error(`Invalid file extension '${extension}' for file '${fullFilename}'.`);
      }

      // Create or get existing file
      let fileObj = this.files.get(fullFilename);
      if (!fileObj) {
        fileObj = new FileClass(name);
        this.files.set(fullFilename, fileObj);
      }

      // Use file-specific write method
      await fileObj.write(content, this.dataDir);
      return `Data written to file ${fullFilename} successfully.`;
    } catch (error) {
      if (error instanceof FileSystemError) {
        return error.message;
      }
      return `Error: Could not write to file '${fullFilename}'. ${(error as Error).message}`;
    }
  }

  /**
   * Append content to file using file-specific append method
   */
  async appendFile(fullFilename: string, content: string): Promise<string> {
    if (!this.isValidFilename(fullFilename)) {
      return INVALID_FILENAME_ERROR_MESSAGE;
    }

    const fileObj = this.getFile(fullFilename);
    if (!fileObj) {
      return `File '${fullFilename}' not found.`;
    }

    try {
      await fileObj.append(content, this.dataDir);
      return `Data appended to file ${fullFilename} successfully.`;
    } catch (error) {
      if (error instanceof FileSystemError) {
        return error.message;
      }
      return `Error: Could not append to file '${fullFilename}'. ${(error as Error).message}`;
    }
  }

  /**
   * Replace old_str with new_str in file
   */
  async replaceFileStr(fullFilename: string, oldStr: string, newStr: string): Promise<string> {
    if (!this.isValidFilename(fullFilename)) {
      return INVALID_FILENAME_ERROR_MESSAGE;
    }

    if (!oldStr) {
      return 'Error: Cannot replace empty string. Please provide a non-empty string to replace.';
    }

    const fileObj = this.getFile(fullFilename);
    if (!fileObj) {
      return `File '${fullFilename}' not found.`;
    }

    try {
      const content = fileObj.read();
      const newContent = content.replace(new RegExp(oldStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), newStr);
      await fileObj.write(newContent, this.dataDir);
      return `Successfully replaced all occurrences of "${oldStr}" with "${newStr}" in file ${fullFilename}`;
    } catch (error) {
      if (error instanceof FileSystemError) {
        return error.message;
      }
      return `Error: Could not replace string in file '${fullFilename}'. ${(error as Error).message}`;
    }
  }

  /**
   * Save extracted content to a numbered file
   */
  async saveExtractedContent(content: string): Promise<string> {
    const initialFilename = `extracted_content_${this.extractedContentCount}`;
    const extractedFilename = `${initialFilename}.md`;

    const fileObj = new MarkdownFile(initialFilename);
    await fileObj.write(content, this.dataDir);
    this.files.set(extractedFilename, fileObj);
    this.extractedContentCount++;

    return `Extracted content saved to file ${extractedFilename} successfully.`;
  }

  /**
   * List all files with their content information using file-specific display methods
   */
  describe(): string {
    const DISPLAY_CHARS = 400;
    let description = '';

    for (const fileObj of this.files.values()) {
      // Skip todo.md from description
      if (fileObj.fullName === 'todo.md') {
        continue;
      }

      const content = fileObj.read();

      // Handle empty files
      if (!content) {
        description += `<file>\n${fileObj.fullName} - [empty file]\n</file>\n`;
        continue;
      }

      const lines = content.split('\n');
      const lineCount = lines.length;

      // For small files, display the entire content
      const wholeFileDescription = `<file>\n${fileObj.fullName} - ${lineCount} lines\n<content>\n${content}\n</content>\n</file>\n`;

      if (content.length < Math.floor(1.5 * DISPLAY_CHARS)) {
        description += wholeFileDescription;
        continue;
      }

      // For larger files, display start and end previews
      const halfDisplayChars = Math.floor(DISPLAY_CHARS / 2);

      // Get start preview
      let startPreview = '';
      let startLineCount = 0;
      let charsCount = 0;

      for (const line of lines) {
        if (charsCount + line.length + 1 > halfDisplayChars) {
          break;
        }
        startPreview += line + '\n';
        charsCount += line.length + 1;
        startLineCount++;
      }

      // Get end preview
      let endPreview = '';
      let endLineCount = 0;
      charsCount = 0;

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (charsCount + line.length + 1 > halfDisplayChars) {
          break;
        }
        endPreview = line + '\n' + endPreview;
        charsCount += line.length + 1;
        endLineCount++;
      }

      // Calculate lines in between
      const middleLineCount = lineCount - startLineCount - endLineCount;
      if (middleLineCount <= 0) {
        description += wholeFileDescription;
        continue;
      }

      startPreview = startPreview.trim();
      endPreview = endPreview.trim();

      // Format output
      if (!startPreview && !endPreview) {
        description += `<file>\n${fileObj.fullName} - ${lineCount} lines\n<content>\n${middleLineCount} lines...\n</content>\n</file>\n`;
      } else {
        description += `<file>\n${fileObj.fullName} - ${lineCount} lines\n<content>\n${startPreview}\n`;
        description += `... ${middleLineCount} more lines ...\n`;
        description += `${endPreview}\n`;
        description += '</content>\n</file>\n';
      }
    }

    return description.trim();
  }

  /**
   * Get todo file contents
   */
  getTodoContents(): string {
    const todoFile = this.getFile('todo.md');
    return todoFile ? todoFile.read() : '';
  }

  /**
   * Get serializable state of the file system
   */
  getState(): FileSystemState {
    const filesData: Record<string, { type: string; data: { name: string; content: string } }> = {};

    for (const [fullFilename, fileObj] of this.files) {
      filesData[fullFilename] = {
        type: fileObj.constructor.name,
        data: fileObj.toJSON(),
      };
    }

    return {
      files: filesData,
      baseDir: this.baseDir,
      extractedContentCount: this.extractedContentCount,
    };
  }

  /**
   * Delete the file system directory
   */
  nuke(): void {
    try {
      rmSync(this.dataDir, { recursive: true, force: true });
    } catch (error) {
      this.logger.error('Failed to nuke file system directory', error as Error);
      throw new FileSystemError(`Failed to delete file system directory: ${(error as Error).message}`);
    }
  }

  /**
   * Restore file system from serializable state at the exact same location
   */
  static fromState(state: FileSystemState): FileSystem {
    // Create file system without default files
    const fs = new FileSystem(state.baseDir, false);
    fs.extractedContentCount = state.extractedContentCount;

    // Restore all files
    for (const [fullFilename, fileData] of Object.entries(state.files)) {
      const fileType = fileData.type;
      const fileInfo = fileData.data;

      // Create the appropriate file object based on type
      let fileObj: BaseFile;
      switch (fileType) {
        case 'MarkdownFile':
          fileObj = new MarkdownFile(fileInfo.name, fileInfo.content);
          break;
        case 'TxtFile':
          fileObj = new TxtFile(fileInfo.name, fileInfo.content);
          break;
        case 'JsonFile':
          fileObj = new JsonFile(fileInfo.name, fileInfo.content);
          break;
        case 'CsvFile':
          fileObj = new CsvFile(fileInfo.name, fileInfo.content);
          break;
        case 'PdfFile':
          fileObj = new PdfFile(fileInfo.name, fileInfo.content);
          break;
        default:
          // Skip unknown file types
          continue;
      }

      // Add to files dict and sync to disk
      fs.files.set(fullFilename, fileObj);
      fileObj.syncToDiskSync(fs.dataDir);
    }

    return fs;
  }
}
