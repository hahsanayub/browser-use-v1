import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileSystem } from '../src/filesystem/file-system.js';

describe('FileSystem docx support', () => {
  it('includes docx in allowed extensions', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-fs-'));
    try {
      const fileSystem = new FileSystem(tempDir, false);
      expect(fileSystem.get_allowed_extensions()).toContain('docx');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('writes docx files and reads them back via external reader', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-fs-'));
    const fileSystem = new FileSystem(tempDir, false);
    try {
      const content = '# Quarterly Report\nRevenue up 12%\n\nMargin stable';
      const writeResult = await fileSystem.write_file('report.docx', content);
      expect(writeResult).toContain('Data written to file report.docx successfully.');

      const fullPath = path.join(fileSystem.get_dir(), 'report.docx');
      expect(fs.existsSync(fullPath)).toBe(true);

      const structured = await fileSystem.read_file_structured(fullPath, true);
      expect(structured.message).toContain(`Read from file ${fullPath}.`);
      expect(structured.message).toContain('Quarterly Report');
      expect(structured.message).toContain('Revenue up 12%');
      expect(structured.message).toContain('Margin stable');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
