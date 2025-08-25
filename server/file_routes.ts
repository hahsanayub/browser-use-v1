import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mime from 'mime-types';

const router = express.Router();

// Helper function to get projects path
function getProjectsPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.join(__dirname, '..', 'projects');
}

// Helper function for recursive directory scanning
function recursiveScan(fullPath: string, relativePath: string, items: any[], projectsPath: string, projectId?: string): void {
  try {
    const entries = fs.readdirSync(fullPath, { withFileTypes: true });

    for (const entry of entries) {
      const itemFullPath = path.join(fullPath, entry.name);
      const itemRelativePath = path.join(relativePath, entry.name);
      
      try {
        const stats = fs.statSync(itemFullPath);
        
        // Create path without project ID segment
        let pathWithoutProject = itemRelativePath;
        if (projectId && pathWithoutProject.startsWith(`${projectId}${path.sep}`)) {
          pathWithoutProject = pathWithoutProject.substring(`${projectId}${path.sep}`.length);
        }
        
        const itemInfo: any = {
          name: entry.name,
          path: pathWithoutProject,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: entry.isFile() ? Math.round((stats.size / 1024) * 100) / 100 : 0,
          lastModified: stats.mtime.getTime() / 1000
        };
        
        // Add file extension for files
        if (entry.isFile()) {
          const ext = path.extname(entry.name);
          itemInfo.ext = ext || null;
        }
        
        items.push(itemInfo);
        
        // Recursively scan subdirectories
        if (entry.isDirectory()) {
          recursiveScan(itemFullPath, itemRelativePath, items, projectsPath, projectId);
        }
      } catch (statError) {
        // Skip files/directories we can't access
        continue;
      }
    }
  } catch (error) {
    // Skip directories we don't have permission to access
    if ((error as any).code !== 'EACCES' && (error as any).code !== 'EPERM') {
      console.error(`Error scanning directory ${fullPath}:`, error);
    }
  }
}

// File download endpoint
router.get('/download', (req, res) => {
  try {
    const { file, sessionId } = req.query;

    if (!file) {
      return res.status(400).json({
        detail: 'Missing required parameter: file'
      });
    }

    const projectsPath = getProjectsPath();
    let filePath: string;
    
    // Construct the full file path
    if (sessionId) {
      // If sessionId is provided, use it as a subfolder: /projects/[sessionId]/[file]
      filePath = path.join(projectsPath, sessionId as string, file as string);
    } else {
      // Otherwise, use the file path directly: /projects/[file]
      filePath = path.join(projectsPath, file as string);
    }

    // Security check: Ensure the file path is within the projects directory
    try {
      const resolvedFilePath = path.resolve(filePath);
      const resolvedProjectsPath = path.resolve(projectsPath);
      if (!resolvedFilePath.startsWith(resolvedProjectsPath)) {
        return res.status(403).json({
          detail: 'Access denied: File path is outside the projects directory'
        });
      }
    } catch (pathError) {
      return res.status(400).json({
        detail: 'Invalid file path'
      });
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        detail: `File not found: ${file}`
      });
    }

    // Check if it's actually a file (not a directory)
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return res.status(400).json({
        detail: `Path is not a file: ${file}`
      });
    }

    // Determine the MIME type
    const mimeType = mime.lookup(filePath) || 'application/octet-stream';
    
    // Set response headers
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    res.setHeader('Content-Length', stats.size.toString());

    // Add session ID to headers if provided (for reference)
    if (sessionId) {
      res.setHeader('X-Session-ID', sessionId as string);
    }

    // Stream the file
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

  } catch (error) {
    console.error(`Error downloading file ${req.query.file}:`, error);
    res.status(500).json({
      detail: `Internal server error while downloading file: ${error}`
    });
  }
});

// File list endpoint
router.get('/files/list', (req, res) => {
  try {
    const { projectId, directory } = req.query;

    const projectsPath = getProjectsPath();
    let targetPath: string;
    
    // Construct the target directory path
    if (projectId) {
      // If projectId is provided, use it as base: /projects/[projectId]
      const basePath = path.join(projectsPath, projectId as string);
      if (directory) {
        targetPath = path.join(basePath, directory as string);
      } else {
        targetPath = basePath;
      }
    } else {
      // Otherwise, use projects root
      if (directory) {
        targetPath = path.join(projectsPath, directory as string);
      } else {
        targetPath = projectsPath;
      }
    }

    // Security check: Ensure the path is within the projects directory
    try {
      const resolvedTargetPath = path.resolve(targetPath);
      const resolvedProjectsPath = path.resolve(projectsPath);
      if (!resolvedTargetPath.startsWith(resolvedProjectsPath)) {
        return res.status(403).json({
          detail: 'Access denied: Directory path is outside the projects directory'
        });
      }
    } catch (pathError) {
      return res.status(400).json({
        detail: 'Invalid directory path'
      });
    }

    // Check if directory exists
    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({
        detail: `Directory not found: ${directory || 'projects'}`
      });
    }

    // Check if it's actually a directory
    const stats = fs.statSync(targetPath);
    if (!stats.isDirectory()) {
      return res.status(400).json({
        detail: `Path is not a directory: ${directory || 'projects'}`
      });
    }

    // Recursively scan all files and directories
    const items: any[] = [];
    const relativePath = path.relative(projectsPath, targetPath);
    recursiveScan(targetPath, relativePath, items, projectsPath, projectId as string);
    
    // Determine the display directory name
    let displayDir: string;
    if (projectId) {
      displayDir = `projects/${projectId}`;
      if (directory) {
        displayDir += `/${directory}`;
      }
    } else {
      displayDir = (directory as string) || 'projects';
    }

    res.json({
      directory: displayDir,
      project_id: projectId || null,
      items: items.sort((a, b) => a.path.localeCompare(b.path)),
      total_items: items.length
    });

  } catch (error) {
    console.error(`Error listing files in ${req.query.directory || 'projects'}:`, error);
    res.status(500).json({
      detail: `Internal server error while listing files: ${error}`
    });
  }
});

export default router;
