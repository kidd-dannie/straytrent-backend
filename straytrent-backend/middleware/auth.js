const { supabase } = require('../utils/supabase');

/**
 * Authentication middleware - verifies JWT token from Supabase
 */
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const token = authHeader.split(' ')[1];
    
    // Verify token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    
    // Get user profile with role
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();
    
    if (profileError) {
      return res.status(401).json({ error: 'User profile not found' });
    }
    
    req.user = {
      id: user.id,
      phone: user.phone,
      role: profile.role,
      ...profile
    };
    
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
}

/**
 * Role-based authorization middleware
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ 
        error: `Access denied. Required role: ${allowedRoles.join(' or ')}`,
        your_role: req.user.role
      });
    }
    
    next();
  };
}

/**
 * Optional: Check if user owns a resource
 */
async function checkOwnership(table, idColumn, userId) {
  const { data, error } = await supabase
    .from(table)
    .select(idColumn)
    .eq(idColumn, userId)
    .single();
  
  return !error && data;
}

module.exports = { authenticate, requireRole, checkOwnership };