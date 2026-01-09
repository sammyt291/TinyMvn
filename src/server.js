const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const chokidar = require('chokidar');

// Load config
const configPath = path.join(__dirname, '..', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Import routes
const authRoutes = require('./routes/auth');
const filesRoutes = require('./routes/files');
const repoRoutes = require('./routes/repo');

const app = express();

// Ensure directories exist
const dirs = [config.storage.uploadDir, config.storage.projectsDir, config.storage.tempDir];
dirs.forEach(dir => {
  const fullPath = path.resolve(__dirname, '..', dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: config.auth.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: config.server.protocol === 'https',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// View engine setup (simple HTML templates)
app.set('views', path.join(__dirname, '..', 'views'));

// Routes
app.use('/auth', authRoutes);
app.use('/files', filesRoutes);
app.use(config.repository.basePath, repoRoutes);

// Home route - redirect to files (public access)
app.get('/', (req, res) => {
  res.redirect('/files');
});

// Server management
let server = null;
let httpsCredentials = null;

function loadHttpsCredentials() {
  const keyPath = path.resolve(__dirname, '..', config.https.keyPath);
  const certPath = path.resolve(__dirname, '..', config.https.certPath);
  
  try {
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      return {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
      };
    }
  } catch (err) {
    console.error('Error loading HTTPS credentials:', err.message);
  }
  return null;
}

function createServer() {
  const { protocol, port, host } = config.server;
  
  if (protocol === 'https') {
    httpsCredentials = loadHttpsCredentials();
    if (!httpsCredentials) {
      console.error('HTTPS credentials not found. Please provide key and cert PEM files.');
      console.log('Expected paths:');
      console.log('  Key:', path.resolve(__dirname, '..', config.https.keyPath));
      console.log('  Cert:', path.resolve(__dirname, '..', config.https.certPath));
      process.exit(1);
    }
    server = https.createServer(httpsCredentials, app);
  } else {
    server = http.createServer(app);
  }
  
  server.listen(port, host, () => {
    console.log(`Server running on ${protocol}://${host}:${port}`);
    console.log(`Repository available at ${protocol}://${host}:${port}${config.repository.basePath}`);
  });
  
  return server;
}

function restartServerWithNewCerts() {
  console.log('Certificate files changed, reloading...');
  
  const newCredentials = loadHttpsCredentials();
  if (!newCredentials) {
    console.error('Failed to reload certificates');
    return;
  }
  
  // Update the server's credentials
  if (server && config.server.protocol === 'https') {
    server.setSecureContext(newCredentials);
    console.log('HTTPS certificates reloaded successfully');
  }
}

// Watch for certificate changes
if (config.server.protocol === 'https' && config.https.watchCerts) {
  const keyPath = path.resolve(__dirname, '..', config.https.keyPath);
  const certPath = path.resolve(__dirname, '..', config.https.certPath);
  
  const watcher = chokidar.watch([keyPath, certPath], {
    persistent: true,
    ignoreInitial: true
  });
  
  watcher.on('change', (filePath) => {
    console.log(`Certificate file changed: ${filePath}`);
    restartServerWithNewCerts();
  });
  
  watcher.on('error', (error) => {
    console.error('Certificate watcher error:', error);
  });
}

// Start the server
createServer();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  if (server) {
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  }
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  if (server) {
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  }
});

module.exports = app;
