import fs from 'node:fs';
import path from 'node:path';

const sourcePath = path.resolve('src/dom/dom_tree/index.js');
const targetDir = path.resolve('dist/dom/dom_tree');
const targetPath = path.join(targetDir, 'index.js');

if (!fs.existsSync(sourcePath)) {
  console.error(`Missing source asset: ${sourcePath}`);
  process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(sourcePath, targetPath);
