// Authentication middleware

// Paths that are allowed even when password change is required
const PASSWORD_CHANGE_ALLOWED_PATHS = [
  '/auth/settings',
  '/auth/change-password',
  '/auth/me',
  '/auth/logout',
  '/auth/users'
];

function isPasswordChangeAllowedPath(originalUrl) {
  const urlPath = originalUrl.split('?')[0]; // Remove query string
  return PASSWORD_CHANGE_ALLOWED_PATHS.some(path => urlPath.startsWith(path));
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    // Check if user needs to change password (but allow access to certain pages)
    if (req.session.usingDefaultPassword && !isPasswordChangeAllowedPath(req.originalUrl)) {
      // Check if it's an API request
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(403).json({ 
          error: 'Password change required', 
          redirect: '/auth/settings?forceChange=true' 
        });
      }
      // Redirect to settings for browser requests
      return res.redirect('/auth/settings?forceChange=true');
    }
    return next();
  }
  
  // Check if it's an API request
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  // Redirect to login for browser requests
  res.redirect('/auth/login');
}

function redirectIfAuthenticated(req, res, next) {
  if (req.session && req.session.user) {
    // If using default password, redirect to settings
    if (req.session.usingDefaultPassword) {
      return res.redirect('/auth/settings?forceChange=true');
    }
    return res.redirect('/files');
  }
  next();
}

module.exports = {
  requireAuth,
  redirectIfAuthenticated
};
