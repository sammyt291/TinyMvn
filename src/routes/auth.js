const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { redirectIfAuthenticated, requireAuth } = require('../middleware/auth');

// Config path
const configPath = path.join(__dirname, '..', '..', 'config.json');

// Load config (fresh read to get latest changes)
function loadConfig() {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// Save config
function saveConfig(config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// Login page
router.get('/login', redirectIfAuthenticated, (req, res) => {
  const loginHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'views', 'login.html'), 'utf8');
  res.send(loginHtml);
});

// Login handler
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const config = loadConfig();
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  
  // Find user in config
  const user = config.auth.users.find(u => u.username === username);
  
  // Check if using default password
  const isDefaultPassword = password === config.auth.defaultPassword;
  
  if (!user) {
    // Check default credentials for admin
    if (username === 'admin' && isDefaultPassword) {
      req.session.user = { username: 'admin' };
      req.session.usingDefaultPassword = true;
      // Force password change for admin using default password
      return res.json({ success: true, redirect: '/auth/settings?forceChange=true' });
    }
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  // Verify password
  try {
    const isValid = await bcrypt.compare(password, user.password);
    
    if (isValid) {
      req.session.user = { username: user.username };
      req.session.usingDefaultPassword = false;
      return res.json({ success: true, redirect: '/files' });
    }
    
    // Also check default password for convenience (but force change)
    if (isDefaultPassword) {
      req.session.user = { username: user.username };
      req.session.usingDefaultPassword = true;
      return res.json({ success: true, redirect: '/auth/settings?forceChange=true' });
    }
    
    return res.status(401).json({ error: 'Invalid credentials' });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Settings page
router.get('/settings', requireAuth, (req, res) => {
  const settingsHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'views', 'settings.html'), 'utf8');
  res.send(settingsHtml);
});

// Get current user info
router.get('/me', requireAuth, (req, res) => {
  res.json({
    user: req.session.user,
    forcePasswordChange: req.session.usingDefaultPassword || false
  });
});

// Change password
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const config = loadConfig();
  const username = req.session.user.username;
  
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required' });
  }
  
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  
  // Check if new password is the same as default
  if (newPassword === config.auth.defaultPassword) {
    return res.status(400).json({ error: 'New password cannot be the default password' });
  }
  
  // Find user
  const userIndex = config.auth.users.findIndex(u => u.username === username);
  
  // Verify current password
  let isValidCurrent = false;
  
  if (userIndex >= 0) {
    isValidCurrent = await bcrypt.compare(currentPassword, config.auth.users[userIndex].password);
  }
  
  // Also accept default password as current if using it
  if (!isValidCurrent && currentPassword === config.auth.defaultPassword) {
    isValidCurrent = true;
  }
  
  if (!isValidCurrent) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  
  try {
    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    
    if (userIndex >= 0) {
      // Update existing user
      config.auth.users[userIndex].password = hashedPassword;
    } else {
      // Create new user entry (for admin using default)
      config.auth.users.push({
        username: username,
        password: hashedPassword
      });
    }
    
    // Save config
    saveConfig(config);
    
    // Clear the force change flag
    req.session.usingDefaultPassword = false;
    
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    console.error('Password change error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// List users (admin only)
router.get('/users', requireAuth, (req, res) => {
  if (req.session.user.username !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  const config = loadConfig();
  
  // Return users without password hashes
  const users = config.auth.users.map(u => ({
    username: u.username,
    usingDefaultPassword: false
  }));
  
  // Check if admin exists in users list
  const adminExists = users.some(u => u.username === 'admin');
  if (!adminExists) {
    users.unshift({ username: 'admin', usingDefaultPassword: true });
  }
  
  res.json({ users });
});

// Create user (admin only)
router.post('/users', requireAuth, async (req, res) => {
  if (req.session.user.username !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  const { username, password } = req.body;
  const config = loadConfig();
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return res.status(400).json({ error: 'Username can only contain letters, numbers, underscores and dashes' });
  }
  
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  
  // Check if user already exists
  if (config.auth.users.some(u => u.username === username)) {
    return res.status(400).json({ error: 'User already exists' });
  }
  
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    
    config.auth.users.push({
      username: username,
      password: hashedPassword
    });
    
    saveConfig(config);
    
    res.json({ success: true, message: 'User created successfully' });
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Reset user password (admin only)
router.put('/users/:username/password', requireAuth, async (req, res) => {
  if (req.session.user.username !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  const { password } = req.body;
  const targetUsername = req.params.username;
  const config = loadConfig();
  
  if (!password) {
    return res.status(400).json({ error: 'Password is required' });
  }
  
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const userIndex = config.auth.users.findIndex(u => u.username === targetUsername);
    
    if (userIndex >= 0) {
      config.auth.users[userIndex].password = hashedPassword;
    } else {
      // Create user entry if doesn't exist (e.g., admin using default)
      config.auth.users.push({
        username: targetUsername,
        password: hashedPassword
      });
    }
    
    saveConfig(config);
    
    res.json({ success: true, message: 'Password reset successfully' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Delete user (admin only)
router.delete('/users/:username', requireAuth, (req, res) => {
  if (req.session.user.username !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  const targetUsername = req.params.username;
  const config = loadConfig();
  
  if (targetUsername === 'admin') {
    return res.status(400).json({ error: 'Cannot delete admin user' });
  }
  
  const userIndex = config.auth.users.findIndex(u => u.username === targetUsername);
  
  if (userIndex < 0) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  config.auth.users.splice(userIndex, 1);
  saveConfig(config);
  
  res.json({ success: true, message: 'User deleted successfully' });
});

// Logout handler
router.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
    }
    res.redirect('/files');
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
