import fs from 'node:fs';
import path from 'node:path';

// Copy all .md files from src/agent to dist/agent
const sourceDir = path.resolve('src/agent');
const targetDir = path.resolve('dist/agent');

// Get all .md files in src/agent
const mdFiles = fs.readdirSync(sourceDir).filter(file => file.endsWith('.md'));

if (mdFiles.length === 0) {
  console.warn('No markdown files found in src/agent');
  process.exit(0);
}

// Ensure target directory exists
fs.mkdirSync(targetDir, { recursive: true });

// Copy each markdown file
mdFiles.forEach(file => {
  const sourcePath = path.join(sourceDir, file);
  const targetPath = path.join(targetDir, file);
  
  try {
    fs.copyFileSync(sourcePath, targetPath);
    console.log(`Copied ${file} to dist/agent/`);
  } catch (error) {
    console.error(`Failed to copy ${file}:`, error.message);
    process.exit(1);
  }
});

console.log(`Successfully copied ${mdFiles.length} markdown file(s)`);
