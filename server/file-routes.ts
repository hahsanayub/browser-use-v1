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
function recursiveScan(dirPath: string, relativePath: string = ''): any[] {
  const items: any[] = [];
  
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const itemRelativePath = path.join(relativePath, entry.name);
      
      if (entry.isDirectory()) {
        const itemInfo: any = {
          name: entry.name,
          path: itemRelativePath,
          type: 'directory'
        };
        items.push(itemInfo);
        
        // Recursively scan subdirectories
        const subItems = recursiveScan(fullPath, itemRelativePath);
        items.push(...subItems);
      } else if (entry.isFile()) {
        const stats = fs.statSync(fullPath);
        const itemInfo: any = {
          name: entry.name,
          path: itemRelativePath,
          type: 'file',
          size: Math.round((stats.size / 1024) * 100) / 100, // Size in KB
          lastModified: stats.mtime.getTime() / 1000, // Unix timestamp
          ext: path.extname(entry.name)
        };
        items.push(itemInfo);
      }
    }
  } catch (error) {
    console.error(`Error scanning directory ${dirPath}:`, error);
  }
  
  return items;
}

// File download endpoint
router.get('/download', (req, res) => {
  try {
    const { file, sessionId } = req.query;
    
    if (!file || !sessionId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameters: file and sessionId'
      });
    }
    
    const projectsPath = getProjectsPath();
    const sessionPath = path.join(projectsPath, sessionId as string, 'browseruse_agent_data');
    const filePath = path.join(sessionPath, file as string);
    
    // Security check: ensure the file is within the session directory
    if (!filePath.startsWith(sessionPath)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: Invalid file path'
      });
    }
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }
    
    const mimeType = mime.lookup(filePath) || 'application/octet-stream';
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    
    if (typeof sessionId === 'string') {
      res.setHeader('X-Session-ID', sessionId);
    }
    
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
    
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// File list endpoint
router.get('/files/list', (req, res) => {
  try {
    const { projectId, directory } = req.query;
    
    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameter: projectId'
      });
    }
    
    const projectsPath = getProjectsPath();
    let targetPath: string;
    
    if (directory) {
      targetPath = path.join(projectsPath, projectId as string, directory as string);
    } else {
      targetPath = path.join(projectsPath, projectId as string, 'browseruse_agent_data');
    }
    
    // Security check: ensure the target path is within the projects directory
    if (!targetPath.startsWith(projectsPath)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: Invalid directory path'
      });
    }
    
    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({
        success: false,
        message: `Directory not found: ${path.relative(projectsPath, targetPath)}`
      });
    }
    
    const items = recursiveScan(targetPath);
    
    res.json({
      success: true,
      data: {
        directory: path.relative(projectsPath, targetPath),
        project_id: projectId,
        items: items,
        total_items: items.length
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('List files error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

export default router;