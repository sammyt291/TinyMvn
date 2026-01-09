const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { redirectIfAuthenticated } = require('../middleware/auth');

// Load config
const configPath = path.join(__dirname, '..', '..', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Login page
router.get('/login', redirectIfAuthenticated, (req, res) => {
  const loginHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'views', 'login.html'), 'utf8');
  res.send(loginHtml);
});

// Login handler
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  
  // Find user in config
  const user = config.auth.users.find(u => u.username === username);
  
  if (!user) {
    // Check default credentials
    if (username === 'admin' && password === config.auth.defaultPassword) {
      req.session.user = { username: 'admin' };
      return res.json({ success: true, redirect: '/files' });
    }
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  // Verify password
  try {
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      // Also check default password for convenience
      if (password === config.auth.defaultPassword) {
        req.session.user = { username: user.username };
        return res.json({ success: true, redirect: '/files' });
      }
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    req.session.user = { username: user.username };
    res.json({ success: true, redirect: '/files' });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Logout handler
router.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
    }
    res.redirect('/auth/login');
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ success: true });
  });
});

module.exports = router;
