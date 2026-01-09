// Authentication middleware

function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    // Check if user needs to change password (but allow access to settings page)
    if (req.session.usingDefaultPassword && 
        !req.path.startsWith('/auth/settings') && 
        !req.path.startsWith('/auth/change-password') &&
        !req.path.startsWith('/auth/me') &&
        !req.path.startsWith('/auth/logout')) {
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
