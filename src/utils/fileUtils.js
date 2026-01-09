const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

/**
 * Find src/main folder in extracted directory
 */
function findSrcMainFolder(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    
    const fullPath = path.join(dir, entry.name);
    
    // Check if this is src/main
    if (entry.name === 'src') {
      const mainPath = path.join(fullPath, 'main');
      if (fs.existsSync(mainPath) && fs.statSync(mainPath).isDirectory()) {
        return mainPath;
      }
    }
    
    // Recursively search in subdirectories
    const found = findSrcMainFolder(fullPath);
    if (found) return found;
  }
  
  return null;
}

/**
 * Fix permissions recursively on a directory
 */
function fixPermissions(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        fs.chmodSync(fullPath, 0o755);
        fixPermissions(fullPath);
      } else {
        fs.chmodSync(fullPath, 0o644);
      }
    }
  } catch (e) {
    // Ignore chmod errors on systems that don't support it
  }
}

/**
 * Extract ZIP file and find src/main folder
 */
function extractAndFindMain(zipPath, extractDir) {
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(extractDir, true);
  
  // Fix permissions on extracted files
  fixPermissions(extractDir);
  
  return findSrcMainFolder(extractDir);
}

/**
 * Get directory tree structure
 */
function getDirectoryTree(dir, baseDir = dir, depth = 0, maxDepth = 5) {
  if (depth > maxDepth) return [];
  
  const entries = [];
  
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      const relativePath = path.relative(baseDir, fullPath);
      
      const entry = {
        name: item.name,
        path: relativePath,
        isDirectory: item.isDirectory(),
        size: item.isFile() ? fs.statSync(fullPath).size : null
      };
      
      if (item.isDirectory()) {
        entry.children = getDirectoryTree(fullPath, baseDir, depth + 1, maxDepth);
      }
      
      entries.push(entry);
    }
  } catch (err) {
    console.error(`Error reading directory ${dir}:`, err.message);
  }
  
  return entries.sort((a, b) => {
    // Directories first, then files
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Delete directory recursively
 */
function deleteDirectory(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Copy directory recursively with proper permissions
 */
function copyDirectory(src, dest) {
  fs.mkdirSync(dest, { recursive: true, mode: 0o755 });
  
  // Ensure the directory is readable
  try {
    fs.chmodSync(dest, 0o755);
  } catch (e) {
    // Ignore chmod errors on systems that don't support it
  }
  
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      // Set file permissions to readable (644)
      try {
        fs.chmodSync(destPath, 0o644);
      } catch (e) {
        // Ignore chmod errors on systems that don't support it
      }
    }
  }
}

/**
 * Format file size
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = {
  findSrcMainFolder,
  extractAndFindMain,
  getDirectoryTree,
  deleteDirectory,
  copyDirectory,
  formatFileSize,
  fixPermissions
};
