// Authentication middleware

function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
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
    return res.redirect('/files');
  }
  next();
}

module.exports = {
  requireAuth,
  redirectIfAuthenticated
};
