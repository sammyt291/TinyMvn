const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const { extractAndFindMain, getDirectoryTree, deleteDirectory, copyDirectory, copyDirectoryWithGitignore, formatFileSize, fixPermissions, findSrcMainFolder } = require('../utils/fileUtils');

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
          githubBranch: meta.githubBranch || null,
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
    
    // Copy extracted files (respecting .gitignore if present)
    copyDirectoryWithGitignore(extractDir, projectPath);
    
    // Extract version: first try filename, then gradle.properties
    let extractedVersion = extractVersionFromFilename(uploadedFile.originalname);
    if (!extractedVersion) {
      extractedVersion = extractVersionFromGradleProperties(extractDir);
    }
    
    // Save metadata
    const meta = {
      originalFilename: uploadedFile.originalname,
      uploadedAt: new Date().toISOString(),
      srcMainPath: srcMainPath ? path.relative(extractDir, srcMainPath) : null,
      size: uploadedFile.size,
      uploadedBy: req.session.user ? req.session.user.username : 'unknown',
      version: extractedVersion || null
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

// Parse GitHub URL to extract owner and repo
function parseGitHubUrl(url) {
  url = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const match = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

// Extract version from filename (e.g., "project-v1.2.3.zip" or "project-1.2.3.zip")
function extractVersionFromFilename(filename) {
  // Remove extension
  const baseName = filename.replace(/\.(zip|tar\.gz|tgz)$/i, '');
  
  // Try to match version patterns like v1.2.3, 1.2.3, v1.2, 1.2
  const patterns = [
    /[-_]v?(\d+\.\d+\.\d+)$/i,        // project-v1.2.3 or project-1.2.3
    /[-_]v?(\d+\.\d+)$/i,              // project-v1.2 or project-1.2
    /v(\d+\.\d+\.\d+)/i,               // contains v1.2.3 anywhere
    /v(\d+\.\d+)/i,                    // contains v1.2 anywhere
    /(\d+\.\d+\.\d+)/,                 // contains 1.2.3 anywhere
  ];
  
  for (const pattern of patterns) {
    const match = baseName.match(pattern);
    if (match) {
      return match[1];
    }
  }
  
  return null;
}

// Find gradle.properties file recursively and extract version
function extractVersionFromGradleProperties(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isFile() && entry.name === 'gradle.properties') {
        // Found gradle.properties, parse it
        const content = fs.readFileSync(fullPath, 'utf8');
        const match = content.match(/^version\s*=\s*(.+)$/m);
        if (match) {
          const version = match[1].trim();
          // Validate it looks like a version (x.y.z or x.y)
          if (/^\d+\.\d+(\.\d+)?(-[\w.]+)?$/.test(version)) {
            return version;
          }
        }
      } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
        // Recursively search in subdirectories
        const found = extractVersionFromGradleProperties(fullPath);
        if (found) return found;
      }
    }
  } catch (e) {
    // Ignore errors reading directories
  }
  
  return null;
}

// Fetch latest version tag from GitHub
async function fetchGitHubVersion(owner, repo) {
  const https = require('https');
  
  return new Promise((resolve) => {
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/tags?per_page=100`;
    
    const options = {
      headers: {
        'User-Agent': 'TinyMvn',
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    
    https.get(apiUrl, options, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        if (response.statusCode !== 200) {
          resolve(null);
          return;
        }
        
        try {
          const tags = JSON.parse(data);
          
          // Find tags matching vX.Y.Z or X.Y.Z pattern
          const versionTags = tags
            .map(t => t.name)
            .filter(name => /^v?\d+\.\d+(\.\d+)?$/.test(name))
            .map(name => ({
              original: name,
              version: name.replace(/^v/, '')
            }))
            .sort((a, b) => {
              // Sort by semantic version (descending)
              const aParts = a.version.split('.').map(Number);
              const bParts = b.version.split('.').map(Number);
              for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
                const aVal = aParts[i] || 0;
                const bVal = bParts[i] || 0;
                if (aVal !== bVal) return bVal - aVal;
              }
              return 0;
            });
          
          if (versionTags.length > 0) {
            resolve(versionTags[0].version);
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

// Fetch branches from GitHub API
router.post('/api/github/branches', requireAuth, async (req, res) => {
  let { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'GitHub URL is required' });
  }
  
  const parsed = parseGitHubUrl(url);
  if (!parsed) {
    return res.status(400).json({ error: 'Invalid GitHub URL. Use format: https://github.com/owner/repo' });
  }
  
  try {
    const https = require('https');
    
    // Fetch branches from GitHub API
    const apiUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/branches?per_page=100`;
    
    const branches = await new Promise((resolve, reject) => {
      const options = {
        headers: {
          'User-Agent': 'TinyMvn',
          'Accept': 'application/vnd.github.v3+json'
        }
      };
      
      https.get(apiUrl, options, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          if (response.statusCode === 404) {
            reject(new Error('Repository not found. Make sure the URL is correct and the repository is public.'));
          } else if (response.statusCode !== 200) {
            reject(new Error(`GitHub API error: ${response.statusCode}`));
          } else {
            try {
              const branches = JSON.parse(data);
              resolve(branches.map(b => b.name));
            } catch (e) {
              reject(new Error('Failed to parse GitHub response'));
            }
          }
        });
      }).on('error', reject);
    });
    
    // Also fetch default branch
    const repoUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
    const defaultBranch = await new Promise((resolve, reject) => {
      const options = {
        headers: {
          'User-Agent': 'TinyMvn',
          'Accept': 'application/vnd.github.v3+json'
        }
      };
      
      https.get(repoUrl, options, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          if (response.statusCode === 200) {
            try {
              const repo = JSON.parse(data);
              resolve(repo.default_branch || 'main');
            } catch (e) {
              resolve('main');
            }
          } else {
            resolve('main');
          }
        });
      }).on('error', () => resolve('main'));
    });
    
    res.json({ 
      branches, 
      defaultBranch,
      owner: parsed.owner,
      repo: parsed.repo 
    });
  } catch (err) {
    console.error('GitHub branches error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch branches' });
  }
});

// Clone from GitHub URL (downloads zip from branch)
router.post('/api/clone', requireAuth, async (req, res) => {
  let { url, branch, projectName } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'GitHub URL is required' });
  }
  
  const parsed = parseGitHubUrl(url);
  if (!parsed) {
    return res.status(400).json({ error: 'Invalid GitHub URL. Use format: https://github.com/owner/repo' });
  }
  
  // Default to main if no branch specified
  branch = branch || 'main';
  
  const tempDir = path.resolve(__dirname, '..', '..', config.storage.tempDir);
  const projectsDir = path.resolve(__dirname, '..', '..', config.storage.projectsDir);
  const zipPath = path.join(tempDir, `${uuidv4()}.zip`);
  const extractDir = path.join(tempDir, uuidv4());
  
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    
    // Download zip from GitHub
    const zipUrl = `https://github.com/${parsed.owner}/${parsed.repo}/archive/refs/heads/${branch}.zip`;
    
    const https = require('https');
    
    await new Promise((resolve, reject) => {
      const downloadZip = (downloadUrl, redirectCount = 0) => {
        if (redirectCount > 5) {
          reject(new Error('Too many redirects'));
          return;
        }
        
        https.get(downloadUrl, (response) => {
          // Handle redirects
          if (response.statusCode === 301 || response.statusCode === 302) {
            const redirectUrl = response.headers.location;
            downloadZip(redirectUrl, redirectCount + 1);
            return;
          }
          
          if (response.statusCode === 404) {
            reject(new Error(`Branch "${branch}" not found. The branch may not exist or the repository may be private.`));
            return;
          }
          
          if (response.statusCode !== 200) {
            reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
            return;
          }
          
          const fileStream = fs.createWriteStream(zipPath);
          response.pipe(fileStream);
          
          fileStream.on('finish', () => {
            fileStream.close();
            resolve();
          });
          
          fileStream.on('error', (err) => {
            fs.unlink(zipPath, () => {});
            reject(err);
          });
        }).on('error', reject);
      };
      
      downloadZip(zipUrl);
    });
    
    // Extract the ZIP
    fs.mkdirSync(extractDir, { recursive: true });
    extractAndFindMain(zipPath, extractDir);
    
    // GitHub zips have a root folder like "repo-branch", find it
    const entries = fs.readdirSync(extractDir);
    let sourceDir = extractDir;
    if (entries.length === 1) {
      const singleEntry = path.join(extractDir, entries[0]);
      if (fs.statSync(singleEntry).isDirectory()) {
        sourceDir = singleEntry;
      }
    }
    
    // Fix permissions
    fixPermissions(sourceDir);
    
    // Find src/main folder
    const srcMainPath = findSrcMainFolder(sourceDir);
    
    // Generate project name
    let finalName = projectName || parsed.repo;
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
    
    // Copy files (respecting .gitignore if present)
    copyDirectoryWithGitignore(sourceDir, projectPath);
    
    // Clean URL for storage (normalize)
    const cleanUrl = `https://github.com/${parsed.owner}/${parsed.repo}`;
    
    // Fetch version: first try GitHub tags, then gradle.properties
    let detectedVersion = await fetchGitHubVersion(parsed.owner, parsed.repo);
    if (!detectedVersion) {
      detectedVersion = extractVersionFromGradleProperties(sourceDir);
    }
    
    // Save metadata
    const meta = {
      originalFilename: parsed.repo,
      uploadedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      srcMainPath: srcMainPath ? path.relative(sourceDir, srcMainPath) : null,
      uploadedBy: req.session.user ? req.session.user.username : 'unknown',
      githubUrl: cleanUrl,
      githubBranch: branch,
      version: detectedVersion || null
    };
    
    fs.writeFileSync(
      path.join(projectPath, '.project-meta.json'),
      JSON.stringify(meta, null, 2)
    );
    
    // Cleanup
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    if (fs.existsSync(extractDir)) deleteDirectory(extractDir);
    
    res.json({
      success: true,
      project: {
        name: finalName,
        srcMainPath: meta.srcMainPath,
        githubUrl: cleanUrl,
        branch: branch
      },
      message: srcMainPath 
        ? `Repository cloned (${branch}). Found src/main at: ${meta.srcMainPath}`
        : `Repository cloned (${branch}). Note: src/main folder not found.`
    });
  } catch (err) {
    console.error('Clone error:', err);
    
    // Cleanup on error
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    if (fs.existsSync(extractDir)) deleteDirectory(extractDir);
    
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
  
  const parsed = parseGitHubUrl(meta.githubUrl);
  if (!parsed) {
    return res.status(400).json({ error: 'Invalid GitHub URL in project metadata' });
  }
  
  const branch = meta.githubBranch || 'main';
  const tempDir = path.resolve(__dirname, '..', '..', config.storage.tempDir);
  const zipPath = path.join(tempDir, `${uuidv4()}.zip`);
  const extractDir = path.join(tempDir, uuidv4());
  
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    
    // Download zip from GitHub
    const zipUrl = `https://github.com/${parsed.owner}/${parsed.repo}/archive/refs/heads/${branch}.zip`;
    
    const https = require('https');
    
    await new Promise((resolve, reject) => {
      const downloadZip = (downloadUrl, redirectCount = 0) => {
        if (redirectCount > 5) {
          reject(new Error('Too many redirects'));
          return;
        }
        
        https.get(downloadUrl, (response) => {
          if (response.statusCode === 301 || response.statusCode === 302) {
            const redirectUrl = response.headers.location;
            downloadZip(redirectUrl, redirectCount + 1);
            return;
          }
          
          if (response.statusCode === 404) {
            reject(new Error(`Branch "${branch}" not found. The branch may have been deleted.`));
            return;
          }
          
          if (response.statusCode !== 200) {
            reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
            return;
          }
          
          const fileStream = fs.createWriteStream(zipPath);
          response.pipe(fileStream);
          
          fileStream.on('finish', () => {
            fileStream.close();
            resolve();
          });
          
          fileStream.on('error', (err) => {
            fs.unlink(zipPath, () => {});
            reject(err);
          });
        }).on('error', reject);
      };
      
      downloadZip(zipUrl);
    });
    
    // Extract the ZIP
    fs.mkdirSync(extractDir, { recursive: true });
    extractAndFindMain(zipPath, extractDir);
    
    // GitHub zips have a root folder like "repo-branch", find it
    const zipEntries = fs.readdirSync(extractDir);
    let sourceDir = extractDir;
    if (zipEntries.length === 1) {
      const singleEntry = path.join(extractDir, zipEntries[0]);
      if (fs.statSync(singleEntry).isDirectory()) {
        sourceDir = singleEntry;
      }
    }
    
    // Fix permissions
    fixPermissions(sourceDir);
    
    // Find src/main folder
    const srcMainPath = findSrcMainFolder(sourceDir);
    
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
    
    // Copy new files (respecting .gitignore if present)
    copyDirectoryWithGitignore(sourceDir, projectPath);
    
    // Fetch latest version: first try GitHub tags, then gradle.properties
    let detectedVersion = await fetchGitHubVersion(parsed.owner, parsed.repo);
    if (!detectedVersion) {
      detectedVersion = extractVersionFromGradleProperties(sourceDir);
    }
    
    // Update metadata
    meta.lastUpdated = new Date().toISOString();
    meta.srcMainPath = srcMainPath ? path.relative(sourceDir, srcMainPath) : null;
    meta.version = detectedVersion || meta.version || null;
    
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    
    // Cleanup
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    if (fs.existsSync(extractDir)) deleteDirectory(extractDir);
    
    res.json({
      success: true,
      message: `Project updated from GitHub (${branch})`,
      lastUpdated: meta.lastUpdated
    });
  } catch (err) {
    console.error('Update error:', err);
    
    // Cleanup on error
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    if (fs.existsSync(extractDir)) deleteDirectory(extractDir);
    
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
