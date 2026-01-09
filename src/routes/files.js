const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const { extractAndFindMain, getDirectoryTree, deleteDirectory, copyDirectory, formatFileSize } = require('../utils/fileUtils');

// Load config
const configPath = path.join(__dirname, '..', '..', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Setup multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.resolve(__dirname, '..', '..', config.storage.uploadDir);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/zip' || 
        file.mimetype === 'application/x-zip-compressed' ||
        file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are allowed'), false);
    }
  },
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
});

// Files page
router.get('/', requireAuth, (req, res) => {
  const filesHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'views', 'files.html'), 'utf8');
  res.send(filesHtml);
});

// List projects
router.get('/api/projects', requireAuth, (req, res) => {
  const projectsDir = path.resolve(__dirname, '..', '..', config.storage.projectsDir);
  
  try {
    if (!fs.existsSync(projectsDir)) {
      return res.json({ projects: [] });
    }
    
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    const projects = entries
      .filter(entry => entry.isDirectory())
      .map(entry => {
        const projectPath = path.join(projectsDir, entry.name);
        const stats = fs.statSync(projectPath);
        const metaPath = path.join(projectPath, '.project-meta.json');
        let meta = {};
        
        if (fs.existsSync(metaPath)) {
          try {
            meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          } catch (e) {}
        }
        
        return {
          name: entry.name,
          uploadedAt: meta.uploadedAt || stats.birthtime,
          srcMainPath: meta.srcMainPath || null,
          originalFilename: meta.originalFilename || entry.name,
          uploadedBy: meta.uploadedBy || 'unknown'
        };
      })
      .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    
    res.json({ projects });
  } catch (err) {
    console.error('Error listing projects:', err);
    res.status(500).json({ error: 'Failed to list projects' });
  }
});

// Get project files
router.get('/api/projects/:name', requireAuth, (req, res) => {
  const projectsDir = path.resolve(__dirname, '..', '..', config.storage.projectsDir);
  const projectPath = path.join(projectsDir, req.params.name);
  
  if (!fs.existsSync(projectPath)) {
    return res.status(404).json({ error: 'Project not found' });
  }
  
  try {
    const tree = getDirectoryTree(projectPath);
    const metaPath = path.join(projectPath, '.project-meta.json');
    let meta = {};
    
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch (e) {}
    }
    
    res.json({ 
      name: req.params.name,
      files: tree,
      meta
    });
  } catch (err) {
    console.error('Error getting project files:', err);
    res.status(500).json({ error: 'Failed to get project files' });
  }
});

// View file content
router.get('/api/projects/:name/file', requireAuth, (req, res) => {
  const projectsDir = path.resolve(__dirname, '..', '..', config.storage.projectsDir);
  const filePath = req.query.path;
  
  if (!filePath) {
    return res.status(400).json({ error: 'File path required' });
  }
  
  const fullPath = path.join(projectsDir, req.params.name, filePath);
  
  // Security check - prevent path traversal
  if (!fullPath.startsWith(path.join(projectsDir, req.params.name))) {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  try {
    const stats = fs.statSync(fullPath);
    
    if (stats.isDirectory()) {
      return res.status(400).json({ error: 'Cannot read directory' });
    }
    
    // Check if file is too large
    if (stats.size > 1024 * 1024) { // 1MB
      return res.json({ 
        content: null, 
        message: 'File too large to display',
        size: formatFileSize(stats.size)
      });
    }
    
    const content = fs.readFileSync(fullPath, 'utf8');
    res.json({ content, size: formatFileSize(stats.size) });
  } catch (err) {
    console.error('Error reading file:', err);
    res.status(500).json({ error: 'Failed to read file' });
  }
});

// Upload ZIP file
router.post('/api/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  const uploadedFile = req.file;
  const tempDir = path.resolve(__dirname, '..', '..', config.storage.tempDir);
  const projectsDir = path.resolve(__dirname, '..', '..', config.storage.projectsDir);
  const extractDir = path.join(tempDir, uuidv4());
  
  try {
    // Create extract directory
    fs.mkdirSync(extractDir, { recursive: true });
    
    // Extract and find src/main
    const srcMainPath = require('../utils/fileUtils').extractAndFindMain(uploadedFile.path, extractDir);
    
    // Generate project name
    let projectName = req.body.projectName || path.basename(uploadedFile.originalname, '.zip');
    projectName = projectName.replace(/[^a-zA-Z0-9-_]/g, '-');
    
    // Ensure unique name
    let finalName = projectName;
    let counter = 1;
    while (fs.existsSync(path.join(projectsDir, finalName))) {
      finalName = `${projectName}-${counter}`;
      counter++;
    }
    
    // Create project directory
    const projectPath = path.join(projectsDir, finalName);
    fs.mkdirSync(projectPath, { recursive: true });
    
    // Copy extracted files
    copyDirectory(extractDir, projectPath);
    
    // Save metadata
    const meta = {
      originalFilename: uploadedFile.originalname,
      uploadedAt: new Date().toISOString(),
      srcMainPath: srcMainPath ? path.relative(extractDir, srcMainPath) : null,
      size: uploadedFile.size,
      uploadedBy: req.session.user ? req.session.user.username : 'unknown'
    };
    
    fs.writeFileSync(
      path.join(projectPath, '.project-meta.json'),
      JSON.stringify(meta, null, 2)
    );
    
    // Cleanup
    deleteDirectory(extractDir);
    fs.unlinkSync(uploadedFile.path);
    
    res.json({
      success: true,
      project: {
        name: finalName,
        srcMainPath: meta.srcMainPath,
        originalFilename: meta.originalFilename
      },
      message: srcMainPath 
        ? `Project uploaded. Found src/main at: ${meta.srcMainPath}`
        : 'Project uploaded. Note: src/main folder not found.'
    });
  } catch (err) {
    console.error('Upload error:', err);
    
    // Cleanup on error
    if (fs.existsSync(extractDir)) {
      deleteDirectory(extractDir);
    }
    if (uploadedFile.path && fs.existsSync(uploadedFile.path)) {
      fs.unlinkSync(uploadedFile.path);
    }
    
    res.status(500).json({ error: 'Failed to process upload: ' + err.message });
  }
});

// Delete project
router.delete('/api/projects/:name', requireAuth, (req, res) => {
  const projectsDir = path.resolve(__dirname, '..', '..', config.storage.projectsDir);
  const projectPath = path.join(projectsDir, req.params.name);
  
  if (!fs.existsSync(projectPath)) {
    return res.status(404).json({ error: 'Project not found' });
  }
  
  try {
    deleteDirectory(projectPath);
    res.json({ success: true, message: 'Project deleted' });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

module.exports = router;
