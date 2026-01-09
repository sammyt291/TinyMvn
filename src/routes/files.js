const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { execSync, spawn } = require('child_process');
const { requireAuth } = require('../middleware/auth');
const { extractAndFindMain, getDirectoryTree, deleteDirectory, copyDirectory, formatFileSize, fixPermissions, findSrcMainFolder } = require('../utils/fileUtils');

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

// Files page (public access)
router.get('/', (req, res) => {
  const filesHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'views', 'files.html'), 'utf8');
  res.send(filesHtml);
});

// Check if user is logged in
router.get('/api/me', (req, res) => {
  if (req.session && req.session.user) {
    res.json({ 
      loggedIn: true, 
      user: { username: req.session.user.username }
    });
  } else {
    res.json({ loggedIn: false });
  }
});

// List projects (public access)
router.get('/api/projects', (req, res) => {
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
          uploadedBy: meta.uploadedBy || 'unknown',
          githubUrl: meta.githubUrl || null,
          lastUpdated: meta.lastUpdated || meta.uploadedAt || stats.birthtime
        };
      })
      .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    
    res.json({ projects });
  } catch (err) {
    console.error('Error listing projects:', err);
    res.status(500).json({ error: 'Failed to list projects' });
  }
});

// Get project files (public access)
router.get('/api/projects/:name', (req, res) => {
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

// View file content (public access)
router.get('/api/projects/:name/file', (req, res) => {
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

// Clone from GitHub URL
router.post('/api/clone', requireAuth, async (req, res) => {
  const { url, projectName } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'GitHub URL is required' });
  }
  
  // Validate GitHub URL
  const githubRegex = /^https?:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/;
  if (!githubRegex.test(url)) {
    return res.status(400).json({ error: 'Invalid GitHub URL. Use format: https://github.com/owner/repo' });
  }
  
  const tempDir = path.resolve(__dirname, '..', '..', config.storage.tempDir);
  const projectsDir = path.resolve(__dirname, '..', '..', config.storage.projectsDir);
  const cloneDir = path.join(tempDir, uuidv4());
  
  try {
    // Create temp directory
    fs.mkdirSync(cloneDir, { recursive: true });
    
    // Clone the repository
    const gitUrl = url.endsWith('.git') ? url : `${url}.git`;
    
    try {
      execSync(`git clone --depth 1 "${gitUrl}" "${cloneDir}"`, {
        timeout: 120000, // 2 minute timeout
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (gitError) {
      throw new Error('Failed to clone repository. Make sure the URL is correct and the repository is public.');
    }
    
    // Remove .git directory to save space
    const gitDir = path.join(cloneDir, '.git');
    if (fs.existsSync(gitDir)) {
      deleteDirectory(gitDir);
    }
    
    // Fix permissions
    fixPermissions(cloneDir);
    
    // Find src/main folder
    const srcMainPath = findSrcMainFolder(cloneDir);
    
    // Generate project name from URL or use provided name
    let finalName = projectName || url.split('/').pop().replace(/\.git$/, '');
    finalName = finalName.replace(/[^a-zA-Z0-9-_]/g, '-');
    
    // Ensure unique name
    let baseName = finalName;
    let counter = 1;
    while (fs.existsSync(path.join(projectsDir, finalName))) {
      finalName = `${baseName}-${counter}`;
      counter++;
    }
    
    // Create project directory
    const projectPath = path.join(projectsDir, finalName);
    fs.mkdirSync(projectPath, { recursive: true });
    
    // Copy cloned files
    copyDirectory(cloneDir, projectPath);
    
    // Save metadata
    const meta = {
      originalFilename: url.split('/').pop(),
      uploadedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      srcMainPath: srcMainPath ? path.relative(cloneDir, srcMainPath) : null,
      uploadedBy: req.session.user ? req.session.user.username : 'unknown',
      githubUrl: url
    };
    
    fs.writeFileSync(
      path.join(projectPath, '.project-meta.json'),
      JSON.stringify(meta, null, 2)
    );
    
    // Cleanup
    deleteDirectory(cloneDir);
    
    res.json({
      success: true,
      project: {
        name: finalName,
        srcMainPath: meta.srcMainPath,
        githubUrl: url
      },
      message: srcMainPath 
        ? `Repository cloned. Found src/main at: ${meta.srcMainPath}`
        : 'Repository cloned. Note: src/main folder not found.'
    });
  } catch (err) {
    console.error('Clone error:', err);
    
    // Cleanup on error
    if (fs.existsSync(cloneDir)) {
      deleteDirectory(cloneDir);
    }
    
    res.status(500).json({ error: err.message || 'Failed to clone repository' });
  }
});

// Update project from GitHub
router.post('/api/projects/:name/update', requireAuth, async (req, res) => {
  const projectsDir = path.resolve(__dirname, '..', '..', config.storage.projectsDir);
  const projectPath = path.join(projectsDir, req.params.name);
  const metaPath = path.join(projectPath, '.project-meta.json');
  
  if (!fs.existsSync(projectPath)) {
    return res.status(404).json({ error: 'Project not found' });
  }
  
  if (!fs.existsSync(metaPath)) {
    return res.status(400).json({ error: 'Project metadata not found' });
  }
  
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (e) {
    return res.status(400).json({ error: 'Invalid project metadata' });
  }
  
  if (!meta.githubUrl) {
    return res.status(400).json({ error: 'This project was not cloned from GitHub' });
  }
  
  const tempDir = path.resolve(__dirname, '..', '..', config.storage.tempDir);
  const cloneDir = path.join(tempDir, uuidv4());
  
  try {
    // Create temp directory
    fs.mkdirSync(cloneDir, { recursive: true });
    
    // Clone the repository
    const gitUrl = meta.githubUrl.endsWith('.git') ? meta.githubUrl : `${meta.githubUrl}.git`;
    
    try {
      execSync(`git clone --depth 1 "${gitUrl}" "${cloneDir}"`, {
        timeout: 120000,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (gitError) {
      throw new Error('Failed to clone repository. The repository may have been deleted or made private.');
    }
    
    // Remove .git directory
    const gitDir = path.join(cloneDir, '.git');
    if (fs.existsSync(gitDir)) {
      deleteDirectory(gitDir);
    }
    
    // Fix permissions
    fixPermissions(cloneDir);
    
    // Find src/main folder
    const srcMainPath = findSrcMainFolder(cloneDir);
    
    // Clear project directory (except metadata)
    const entries = fs.readdirSync(projectPath);
    for (const entry of entries) {
      if (entry !== '.project-meta.json') {
        const entryPath = path.join(projectPath, entry);
        if (fs.statSync(entryPath).isDirectory()) {
          deleteDirectory(entryPath);
        } else {
          fs.unlinkSync(entryPath);
        }
      }
    }
    
    // Copy new files
    copyDirectory(cloneDir, projectPath);
    
    // Update metadata
    meta.lastUpdated = new Date().toISOString();
    meta.srcMainPath = srcMainPath ? path.relative(cloneDir, srcMainPath) : null;
    
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    
    // Cleanup
    deleteDirectory(cloneDir);
    
    res.json({
      success: true,
      message: 'Project updated from GitHub',
      lastUpdated: meta.lastUpdated
    });
  } catch (err) {
    console.error('Update error:', err);
    
    // Cleanup on error
    if (fs.existsSync(cloneDir)) {
      deleteDirectory(cloneDir);
    }
    
    res.status(500).json({ error: err.message || 'Failed to update from GitHub' });
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
