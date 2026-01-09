const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Load config
const configPath = path.join(__dirname, '..', '..', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

/**
 * Repository browser page
 */
router.get('/', (req, res) => {
  const repoHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'views', 'repo.html'), 'utf8');
  res.send(repoHtml);
});

/**
 * List all available artifacts
 */
router.get('/api/artifacts', (req, res) => {
  const projectsDir = path.resolve(__dirname, '..', '..', config.storage.projectsDir);
  
  try {
    if (!fs.existsSync(projectsDir)) {
      return res.json({ artifacts: [] });
    }
    
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    const artifacts = entries
      .filter(entry => entry.isDirectory())
      .map(entry => {
        const projectPath = path.join(projectsDir, entry.name);
        const metaPath = path.join(projectPath, '.project-meta.json');
        let meta = {};
        
        if (fs.existsSync(metaPath)) {
          try {
            meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          } catch (e) {}
        }
        
        // Generate Maven-style coordinates
        const groupId = config.repository.groupId;
        const artifactId = entry.name;
        const version = meta.version || '1.0.0'; // Use detected version or default
        
        return {
          name: entry.name,
          groupId,
          artifactId,
          version,
          srcMainPath: meta.srcMainPath,
          mavenPath: `/${groupId.replace(/\./g, '/')}/${artifactId}/${version}`,
          dependency: {
            maven: `<dependency>\n  <groupId>${groupId}</groupId>\n  <artifactId>${artifactId}</artifactId>\n  <version>${version}</version>\n</dependency>`,
            gradle: `implementation '${groupId}:${artifactId}:${version}'`
          }
        };
      });
    
    res.json({ 
      artifacts,
      repositoryUrl: `${req.protocol}://${req.get('host')}${config.repository.basePath}`
    });
  } catch (err) {
    console.error('Error listing artifacts:', err);
    res.status(500).json({ error: 'Failed to list artifacts' });
  }
});

/**
 * Serve files from projects as Maven repository structure
 * Pattern: /groupId/artifactId/version/artifactId-version.ext
 */
router.get('/*', (req, res, next) => {
  // Skip API routes and root
  if (req.path === '/' || req.path.startsWith('/api/')) {
    return next();
  }
  
  const requestPath = req.path.substring(1); // Remove leading slash
  const pathParts = requestPath.split('/');
  
  // Need at least groupId parts + artifactId + version + filename
  if (pathParts.length < 4) {
    return res.status(404).send('Not found');
  }
  
  const projectsDir = path.resolve(__dirname, '..', '..', config.storage.projectsDir);
  
  // Parse Maven path structure
  // Example: com/example/my-project/1.0.0/my-project-1.0.0.jar
  const filename = pathParts[pathParts.length - 1];
  const version = pathParts[pathParts.length - 2];
  const artifactId = pathParts[pathParts.length - 3];
  const groupIdParts = pathParts.slice(0, pathParts.length - 3);
  const groupId = groupIdParts.join('.');
  
  // Check if this is requesting metadata
  if (filename === 'maven-metadata.xml') {
    return serveMavenMetadata(req, res, artifactId, groupId, version);
  }
  
  // Check for checksum requests
  if (filename.endsWith('.sha1') || filename.endsWith('.md5')) {
    return serveChecksum(req, res, projectsDir, artifactId, filename);
  }
  
  // Try to find and serve the project files
  const projectPath = path.join(projectsDir, artifactId);
  
  if (!fs.existsSync(projectPath)) {
    return res.status(404).send('Artifact not found');
  }
  
  // Determine what file is being requested
  const metaPath = path.join(projectPath, '.project-meta.json');
  let srcMainPath = '';
  
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      srcMainPath = meta.srcMainPath || '';
    } catch (e) {}
  }
  
  // If requesting a JAR, create a ZIP of the src/main folder
  if (filename.endsWith('.jar') || filename.endsWith('.zip')) {
    return serveProjectAsArchive(req, res, projectPath, srcMainPath, filename);
  }
  
  // If requesting POM, generate a basic POM
  if (filename.endsWith('.pom')) {
    return servePom(req, res, groupId, artifactId, version);
  }
  
  // Try to serve the file directly from the project
  const directPath = path.join(projectPath, filename);
  if (fs.existsSync(directPath)) {
    return res.sendFile(directPath);
  }
  
  // Try from src/main
  if (srcMainPath) {
    const srcPath = path.join(projectPath, srcMainPath, filename);
    if (fs.existsSync(srcPath)) {
      return res.sendFile(srcPath);
    }
  }
  
  res.status(404).send('File not found');
});

/**
 * Generate and serve Maven metadata
 */
function serveMavenMetadata(req, res, artifactId, groupId, version) {
  const metadata = `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>${groupId || config.repository.groupId}</groupId>
  <artifactId>${artifactId}</artifactId>
  <versioning>
    <latest>${version || '1.0.0'}</latest>
    <release>${version || '1.0.0'}</release>
    <versions>
      <version>${version || '1.0.0'}</version>
    </versions>
    <lastUpdated>${new Date().toISOString().replace(/[-:T.Z]/g, '').substring(0, 14)}</lastUpdated>
  </versioning>
</metadata>`;
  
  res.type('application/xml').send(metadata);
}

/**
 * Generate and serve POM file
 */
function servePom(req, res, groupId, artifactId, version) {
  const pom = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>${groupId || config.repository.groupId}</groupId>
  <artifactId>${artifactId}</artifactId>
  <version>${version}</version>
  <packaging>jar</packaging>
</project>`;
  
  res.type('application/xml').send(pom);
}

/**
 * Serve project as archive (JAR/ZIP)
 */
function serveProjectAsArchive(req, res, projectPath, srcMainPath, filename) {
  const AdmZip = require('adm-zip');
  
  try {
    const zip = new AdmZip();
    const basePath = srcMainPath ? path.join(projectPath, srcMainPath) : projectPath;
    
    if (!fs.existsSync(basePath)) {
      return res.status(404).send('Source not found');
    }
    
    // Add files to archive
    addDirectoryToZip(zip, basePath, '');
    
    const buffer = zip.toBuffer();
    
    res.set({
      'Content-Type': 'application/java-archive',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length
    });
    
    res.send(buffer);
  } catch (err) {
    console.error('Error creating archive:', err);
    res.status(500).send('Failed to create archive');
  }
}

/**
 * Recursively add directory contents to ZIP
 */
function addDirectoryToZip(zip, dirPath, zipPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  
  for (const entry of entries) {
    if (entry.name === '.project-meta.json') continue;
    
    const fullPath = path.join(dirPath, entry.name);
    const entryPath = zipPath ? `${zipPath}/${entry.name}` : entry.name;
    
    if (entry.isDirectory()) {
      addDirectoryToZip(zip, fullPath, entryPath);
    } else {
      const content = fs.readFileSync(fullPath);
      zip.addFile(entryPath, content);
    }
  }
}

/**
 * Serve checksum files
 */
function serveChecksum(req, res, projectsDir, artifactId, filename) {
  // Generate a simple checksum based on project modification time
  const projectPath = path.join(projectsDir, artifactId);
  
  if (!fs.existsSync(projectPath)) {
    return res.status(404).send('Not found');
  }
  
  const stats = fs.statSync(projectPath);
  const data = `${artifactId}-${stats.mtimeMs}`;
  
  let hash;
  if (filename.endsWith('.sha1')) {
    hash = crypto.createHash('sha1').update(data).digest('hex');
  } else {
    hash = crypto.createHash('md5').update(data).digest('hex');
  }
  
  res.type('text/plain').send(hash);
}

module.exports = router;
