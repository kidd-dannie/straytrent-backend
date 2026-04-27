const express = require('express');
const router = express.Router();
const { supabase, supabaseAdmin, generateOTP, storeOTP, verifyOTP } = require('../utils/supabase');
const { sendOTPEmail, sendWelcomeEmail } = require('../utils/email');

/**
 * Step 1: Send OTP to email
 * POST /api/auth/send-otp
 */
router.post('/send-otp', async (req, res) => {
  try {
    const { email, purpose = 'login' } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email address required' });
    }
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    
    // Generate OTP
    const otp = generateOTP();
    
    // Store OTP in database
    await storeOTP(email, otp, purpose);
    
    // Send OTP via email
    await sendOTPEmail(email, otp, purpose);
    
    // Log notification
    await supabaseAdmin
      .from('notifications_log')
      .insert({
        recipient_email: email,
        notification_type: 'otp',
        channel: 'email',
        message: `OTP: ${otp}`,
        status: 'sent',
        sent_at: new Date().toISOString()
      });
    
    res.json({ 
      success: true, 
      message: `OTP sent to ${email}`,
      // For development only - remove in production
      ...(process.env.NODE_ENV === 'development' && { test_otp: otp })
    });
    
  } catch (error) {
    console.error('Send OTP error:', error);
    res.status(500).json({ error: error.message || 'Failed to send OTP' });
  }
});

/**
 * Step 2: Verify OTP and create/authenticate user
 * POST /api/auth/verify-otp
 */
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, code, full_name, role = 'student' } = req.body;
    
    if (!email || !code) {
      return res.status(400).json({ error: 'Email and OTP required' });
    }
    
    // Verify OTP
    await verifyOTP(email, code, 'login');
    
    // Check if user already exists in Supabase Auth
    const { data: existingAuthUser, error: authCheckError } = await supabaseAdmin.auth.admin
      .listUsers();
    
    let authUser = existingAuthUser?.users?.find(u => u.email === email);
    
    if (!authUser) {
      // Create new user in Supabase Auth
      const { data: newUser, error: createError } = await supabaseAdmin.auth.admin
        .createUser({
          email,
          email_confirm: true, // Auto-confirm since we verified via OTP
          user_metadata: { full_name, role }
        });
      
      if (createError) throw createError;
      authUser = newUser.user;
    }
    
    // Check if profile exists
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('*')
      .eq('email', email)
      .single();
    
    let profile;
    
    if (!existingProfile) {
      // Create new profile
      const { data: newProfile, error: profileError } = await supabaseAdmin
        .from('profiles')
        .insert({
          id: authUser.id,
          email,
          full_name: full_name || authUser.user_metadata?.full_name,
          role,
          kyc_verified: false
        })
        .select()
        .single();
      
      if (profileError) throw profileError;
      profile = newProfile;
      
      // Send welcome email
      await sendWelcomeEmail(email, profile.full_name, role);
    } else {
      profile = existingProfile;
    }
    
    // Sign in the user to get a session
    const { data: sessionData, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password: 'temporary-password-not-used' // This is a workaround - in production use magic link
    });
    
    // Alternative: Create a custom JWT token
    const { data: { session }, error: sessionError } = await supabaseAdmin.auth.admin
      .createSession(authUser.id);
    
    if (sessionError) {
      // Fallback: Create a custom token
      const { data: customToken, error: tokenError } = await supabaseAdmin.auth.admin
        .generateLink({ type: 'magiclink', email });
      
      if (tokenError) throw tokenError;
    }
    
    res.json({
      success: true,
      session: session || { access_token: 'use-supabase-auth-signin' },
      user: {
        id: profile.id,
        email: profile.email,
        full_name: profile.full_name,
        role: profile.role,
        verified_badge: profile.verified_badge,
        kyc_verified: profile.kyc_verified
      }
    });
    
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(401).json({ error: error.message || 'Failed to verify OTP' });
  }
});

/**
 * Get current user profile
 * GET /api/auth/me
 */
router.get('/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();
    
    if (profileError) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    
    res.json({
      id: profile.id,
      email: profile.email,
      full_name: profile.full_name,
      role: profile.role,
      kyc_verified: profile.kyc_verified,
      verified_badge: profile.verified_badge,
      average_rating: profile.average_rating,
      total_ratings: profile.total_ratings,
      phone_number: profile.phone_number
    });
    
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

/**
 * Update user profile
 * PUT /api/auth/profile
 */
router.put('/profile', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const { full_name, phone_number, school_id_url, government_id_url, selfie_url } = req.body;
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    
    if (userError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    
    const updates = {};
    if (full_name) updates.full_name = full_name;
    if (phone_number) updates.phone_number = phone_number;
    if (school_id_url) updates.school_id_url = school_id_url;
    if (government_id_url) updates.government_id_url = government_id_url;
    if (selfie_url) updates.selfie_url = selfie_url;
    
    const { data: profile, error: updateError } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', user.id)
      .select()
      .single();
    
    if (updateError) {
      return res.status(500).json({ error: 'Failed to update profile' });
    }
    
    res.json({ success: true, profile });
    
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

/**
 * Resend OTP
 * POST /api/auth/resend-otp
 */
router.post('/resend-otp', async (req, res) => {
  try {
    const { email, purpose = 'login' } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }
    
    const otp = generateOTP();
    await storeOTP(email, otp, purpose);
    await sendOTPEmail(email, otp, purpose);
    
    res.json({ 
      success: true, 
      message: `New OTP sent to ${email}`,
      ...(process.env.NODE_ENV === 'development' && { test_otp: otp })
    });
    
  } catch (error) {
    console.error('Resend OTP error:', error);
    res.status(500).json({ error: 'Failed to resend OTP' });
  }
});

module.exports = router;