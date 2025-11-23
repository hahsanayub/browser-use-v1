import fsSync from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

type PdfParseFn = (
  dataBuffer: Buffer,
  options?: import('pdf-parse').Options
) => Promise<import('pdf-parse').Result>;
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse') as PdfParseFn;

export const INVALID_FILENAME_ERROR_MESSAGE =
  'Error: Invalid filename format. Must be alphanumeric with supported extension.';
export const DEFAULT_FILE_SYSTEM_PATH = 'browseruse_agent_data';

const DEFAULT_EXTENSIONS = ['md', 'txt', 'json', 'csv', 'pdf'];
const filenameRegex = new RegExp(
  `^[a-zA-Z0-9_\\-]+\\.(${DEFAULT_EXTENSIONS.join('|')})$`
);

export class FileSystemError extends Error {}

abstract class BaseFile {
  constructor(
    public name: string,
    protected content = ''
  ) {}

  abstract get extension(): string;

  get fullName() {
    return `${this.name}.${this.extension}`;
  }

  get size() {
    return this.content.length;
  }

  get lineCount() {
    return this.content ? this.content.split(/\r?\n/).length : 0;
  }

  protected writeFileContent(content: string) {
    this.content = content;
  }

  protected appendFileContent(content: string) {
    this.content = `${this.content}${content}`;
  }

  read() {
    return this.content;
  }

  async syncToDisk(dir: string) {
    await fsp.writeFile(path.join(dir, this.fullName), this.content, 'utf-8');
  }

  syncToDiskSync(dir: string) {
    fsSync.writeFileSync(path.join(dir, this.fullName), this.content, 'utf-8');
  }

  async write(content: string, dir: string) {
    this.writeFileContent(content);
    await this.syncToDisk(dir);
  }

  writeSync(content: string, dir: string) {
    this.writeFileContent(content);
    this.syncToDiskSync(dir);
  }

  async append(content: string, dir: string) {
    this.appendFileContent(content);
    await this.syncToDisk(dir);
  }

  appendSync(content: string, dir: string) {
    this.appendFileContent(content);
    this.syncToDiskSync(dir);
  }

  toJSON() {
    return { name: this.name, content: this.content };
  }
}

class MarkdownFile extends BaseFile {
  override get extension() {
    return 'md';
  }
}

class TxtFile extends BaseFile {
  override get extension() {
    return 'txt';
  }
}

class JsonFile extends BaseFile {
  override get extension() {
    return 'json';
  }
}

class CsvFile extends BaseFile {
  override get extension() {
    return 'csv';
  }
}

class PdfFile extends BaseFile {
  override get extension() {
    return 'pdf';
  }

  override async syncToDisk(dir: string) {
    const filePath = path.join(dir, this.fullName);
    await new Promise<void>((resolve, reject) => {
      const doc = new PDFDocument({ autoFirstPage: true });
      const stream = fsSync.createWriteStream(filePath);
      doc.pipe(stream);
      doc.fontSize(12).text(this.content || '', { width: 500, align: 'left' });
      doc.end();
      stream.on('finish', resolve);
      stream.on('error', reject);
    });
  }

  override syncToDiskSync(dir: string) {
    const filePath = path.join(dir, this.fullName);
    const script = `
const { createWriteStream } = require('fs');
const PDFDocument = require(${JSON.stringify(require.resolve('pdfkit'))});
const filePath = ${JSON.stringify(filePath)};
const content = ${JSON.stringify(this.content ?? '')};
const doc = new PDFDocument({ autoFirstPage: true });
const stream = createWriteStream(filePath);
doc.pipe(stream);
doc.fontSize(12).text(content || '', { width: 500, align: 'left' });
doc.end();
stream.on('finish', () => process.exit(0));
stream.on('error', (err) => {
	console.error(err);
	process.exit(1);
});
`;
    const result = spawnSync(process.execPath, ['-e', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    if (result.status !== 0) {
      const errorMsg =
        result.stderr?.toString() ||
        `Could not write to file '${this.fullName}'.`;
      throw new FileSystemError(`Error: ${errorMsg.trim()}`);
    }
  }
}

type FileClass = new (name: string, content?: string) => BaseFile;

const FILE_TYPES: Record<string, FileClass> = {
  md: MarkdownFile,
  txt: TxtFile,
  json: JsonFile,
  csv: CsvFile,
  pdf: PdfFile,
};

const TYPE_NAME_MAP: Record<string, FileClass> = {
  MarkdownFile,
  TxtFile,
  JsonFile,
  CsvFile,
  PdfFile,
};

export interface FileState {
  type: string;
  data: { name: string; content: string };
}

export interface FileSystemState {
  files: Record<string, FileState>;
  base_dir: string;
  extracted_content_count: number;
}

export class FileSystem {
  private files = new Map<string, BaseFile>();
  private readonly defaultFiles = ['todo.md'];
  private readonly baseDir: string;
  public readonly dataDir: string;
  public extractedContentCount = 0;

  constructor(baseDir: string, createDefaultFiles = true) {
    this.baseDir = path.resolve(baseDir);
    fsSync.mkdirSync(this.baseDir, { recursive: true });
    this.dataDir = path.join(this.baseDir, DEFAULT_FILE_SYSTEM_PATH);
    if (fsSync.existsSync(this.dataDir)) {
      fsSync.rmSync(this.dataDir, { recursive: true, force: true });
    }
    fsSync.mkdirSync(this.dataDir, { recursive: true });

    if (createDefaultFiles) {
      this.createDefaultFiles();
    }
  }

  private createDefaultFiles() {
    for (const filename of this.defaultFiles) {
      const file = this.instantiateFile(filename);
      this.files.set(filename, file);
      fsSync.writeFileSync(
        path.join(this.dataDir, filename),
        file.read(),
        'utf-8'
      );
    }
  }

  private isValidFilename(filename: string) {
    return filenameRegex.test(filename);
  }

  private parseFilename(filename: string): [string, string] {
    const idx = filename.lastIndexOf('.');
    if (idx === -1) {
      throw new FileSystemError(INVALID_FILENAME_ERROR_MESSAGE);
    }
    const name = filename.slice(0, idx);
    const extension = filename.slice(idx + 1).toLowerCase();
    return [name, extension];
  }

  private getFileClass(extension: string) {
    return FILE_TYPES[extension];
  }

  private instantiateFile(fullFilename: string, content = '') {
    const [name, extension] = this.parseFilename(fullFilename);
    const FileCtor = this.getFileClass(extension);
    if (!FileCtor) {
      throw new FileSystemError(INVALID_FILENAME_ERROR_MESSAGE);
    }
    return new FileCtor(name, content);
  }

  get_allowed_extensions() {
    return Object.keys(FILE_TYPES);
  }

  get_dir() {
    return this.dataDir;
  }

  get_file(filename: string) {
    return this.files.get(filename) ?? null;
  }

  list_files() {
    return Array.from(this.files.values()).map((file) => file.fullName);
  }

  display_file(filename: string) {
    if (!this.isValidFilename(filename)) {
      return null;
    }
    const file = this.get_file(filename);
    return file ? file.read() : null;
  }

  async read_file(filename: string, externalFile = false) {
    if (externalFile) {
      try {
        const [, extension] = this.parseFilename(filename);
        if (['md', 'txt', 'json', 'csv'].includes(extension)) {
          const content = await fsp.readFile(filename, 'utf-8');
          return `Read from file ${filename}.\n<content>\n${content}\n</content>`;
        }
        if (extension === 'pdf') {
          const buffer = await fsp.readFile(filename);
          const parsed = await pdfParse(buffer);
          const totalPages = parsed.numpages ?? 0;
          const extraPages = Math.max(0, totalPages - 10);
          const snippet = parsed.text?.trim() || '';
          const preview = snippet
            .split(/\n{2,}/)
            .slice(0, 10)
            .join('\n\n');
          const suffix = extraPages > 0 ? `\n${extraPages} more pages...` : '';
          return `Read from file ${filename}.\n<content>\n${preview}${suffix}\n</content>`;
        }
        return `Error: Cannot read file ${filename} as ${extension} extension is not supported.`;
      } catch (error: any) {
        if (error?.code === 'ENOENT') {
          return `Error: File '${filename}' not found.`;
        }
        if (error?.code === 'EACCES') {
          return `Error: Permission denied to read file '${filename}'.`;
        }
        return `Error: Could not read file '${filename}'.`;
      }
    }

    if (!this.isValidFilename(filename)) {
      return INVALID_FILENAME_ERROR_MESSAGE;
    }

    const file = this.get_file(filename);
    if (!file) {
      return `File '${filename}' not found.`;
    }

    try {
      const content = file.read();
      return `Read from file ${filename}.\n<content>\n${content}\n</content>`;
    } catch (error) {
      return error instanceof FileSystemError
        ? error.message
        : `Error: Could not read file '${filename}'.`;
    }
  }

  async write_file(filename: string, content: string) {
    if (!this.isValidFilename(filename)) {
      return INVALID_FILENAME_ERROR_MESSAGE;
    }

    const file = this.files.get(filename) ?? this.instantiateFile(filename);
    this.files.set(filename, file);

    try {
      await file.write(content, this.dataDir);
      return `Data written to file ${filename} successfully.`;
    } catch (error) {
      return `Error: Could not write to file '${filename}'. ${(error as Error).message}`;
    }
  }

  async append_file(filename: string, content: string) {
    if (!this.isValidFilename(filename)) {
      return INVALID_FILENAME_ERROR_MESSAGE;
    }

    const file = this.get_file(filename);
    if (!file) {
      return `File '${filename}' not found.`;
    }

    try {
      await file.append(content, this.dataDir);
      return `Data appended to file ${filename} successfully.`;
    } catch (error) {
      return `Error: Could not append to file '${filename}'. ${(error as Error).message}`;
    }
  }

  async replace_file_str(filename: string, oldStr: string, newStr: string) {
    if (!this.isValidFilename(filename)) {
      return INVALID_FILENAME_ERROR_MESSAGE;
    }
    if (!oldStr) {
      return 'Error: Cannot replace empty string. Please provide a non-empty string to replace.';
    }

    const file = this.get_file(filename);
    if (!file) {
      return `File '${filename}' not found.`;
    }

    try {
      const content = file.read().replaceAll(oldStr, newStr);
      await file.write(content, this.dataDir);
      return `Successfully replaced all occurrences of "${oldStr}" with "${newStr}" in file ${filename}`;
    } catch (error) {
      return `Error: Could not replace string in file '${filename}'. ${(error as Error).message}`;
    }
  }

  async save_extracted_content(content: string) {
    const filename = `extracted_content_${this.extractedContentCount}.md`;
    const file = new MarkdownFile(
      `extracted_content_${this.extractedContentCount}`
    );
    await file.write(content, this.dataDir);
    this.files.set(filename, file);
    this.extractedContentCount += 1;
    return `Extracted content saved to file ${filename} successfully.`;
  }

  describe() {
    const DISPLAY_CHARS = 400;
    let description = '';

    for (const file of this.files.values()) {
      if (file.fullName === 'todo.md') {
        continue;
      }

      const content = file.read();
      if (!content) {
        description += `<file>\n${file.fullName} - [empty file]\n</file>\n`;
        continue;
      }

      const lines = content.split(/\r?\n/);
      const lineCount = lines.length;

      if (content.length < DISPLAY_CHARS * 1.5) {
        description += `<file>\n${file.fullName} - ${lineCount} lines\n<content>\n${content}\n</content>\n</file>\n`;
        continue;
      }

      const halfChars = Math.floor(DISPLAY_CHARS / 2);
      let startPreview = '';
      let startLines = 0;
      let accumulated = 0;

      for (const line of lines) {
        if (accumulated + line.length + 1 > halfChars) {
          break;
        }
        startPreview += `${line}\n`;
        accumulated += line.length + 1;
        startLines += 1;
      }

      let endPreview = '';
      let endLines = 0;
      accumulated = 0;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (accumulated + line.length + 1 > halfChars) {
          break;
        }
        endPreview = `${line}\n${endPreview}`;
        accumulated += line.length + 1;
        endLines += 1;
      }

      const middleLines = lineCount - startLines - endLines;
      if (middleLines <= 0) {
        description += `<file>\n${file.fullName} - ${lineCount} lines\n<content>\n${content}\n</content>\n</file>\n`;
        continue;
      }

      description += `<file>\n${file.fullName} - ${lineCount} lines\n<content>\n${startPreview.trim()}\n`;
      description += `... ${middleLines} more lines ...\n`;
      description += `${endPreview.trim()}\n</content>\n</file>\n`;
    }

    return description.trim();
  }

  get_todo_contents() {
    const todo = this.get_file('todo.md');
    return todo?.read() ?? '';
  }

  get_state(): FileSystemState {
    const files: Record<string, FileState> = {};
    for (const [filename, file] of this.files.entries()) {
      files[filename] = { type: file.constructor.name, data: file.toJSON() };
    }
    return {
      files,
      base_dir: this.baseDir,
      extracted_content_count: this.extractedContentCount,
    };
  }

  async nuke() {
    await fsp.rm(this.dataDir, { recursive: true, force: true });
  }

  static from_state_sync(state: FileSystemState) {
    const fsInstance = new FileSystem(state.base_dir, false);
    fsInstance.extractedContentCount = state.extracted_content_count;

    for (const [filename, fileState] of Object.entries(state.files)) {
      const FileCtor = TYPE_NAME_MAP[fileState.type];
      if (!FileCtor) {
        continue;
      }
      const file = new FileCtor(fileState.data.name, fileState.data.content);
      fsInstance.files.set(filename, file);
      try {
        file.writeSync(fileState.data.content, fsInstance.dataDir);
      } catch (error) {
        throw new FileSystemError(
          `Error restoring file '${filename}': ${(error as Error).message}`
        );
      }
    }

    return fsInstance;
  }

  static async from_state(state: FileSystemState) {
    return FileSystem.from_state_sync(state);
  }
}

export type { FileSystemState };
