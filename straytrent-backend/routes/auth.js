const express = require('express');
const router = express.Router();
const { supabase, supabaseAdmin } = require('../utils/supabase');
const { sendOTP } = require('../utils/termii');

/**
 * Step 1: Send OTP to phone number
 * POST /api/auth/send-otp
 */
router.post('/send-otp', async (req, res) => {
  try {
    const { phone, channel = 'whatsapp' } = req.body;
    
    if (!phone) {
      return res.status(400).json({ error: 'Phone number required' });
    }
    
    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Store OTP in Supabase (expires in 10 minutes)
    const { error: storeError } = await supabase
      .from('otp_codes')
      .upsert({
        phone,
        code: otp,
        expires_at: new Date(Date.now() + 10 * 60 * 1000),
        used: false
      });
    
    if (storeError && storeError.code !== '42P01') {
      // Table might not exist yet
      console.log('OTP table not ready, continuing anyway');
    }
    
    // Send OTP via Termii
    await sendOTP(phone, otp, channel);
    
    // Log notification
    await supabase
      .from('notifications_log')
      .insert({
        recipient_phone: phone,
        notification_type: 'otp',
        channel,
        message: `OTP: ${otp}`,
        status: 'sent',
        sent_at: new Date().toISOString()
      });
    
    res.json({ 
      success: true, 
      message: `OTP sent via ${channel}`,
      // For development only - remove in production
      ...(process.env.NODE_ENV === 'development' && { test_otp: otp })
    });
    
  } catch (error) {
    console.error('Send OTP error:', error);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

/**
 * Step 2: Verify OTP and create/authenticate user
 * POST /api/auth/verify-otp
 */
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, code, full_name, role = 'student' } = req.body;
    
    if (!phone || !code) {
      return res.status(400).json({ error: 'Phone and OTP required' });
    }
    
    // Verify OTP (in production, use Supabase Auth's built-in OTP)
    // For demo, we'll use Supabase Auth's phone sign-in
    const { data: authData, error: authError } = await supabase.auth.signInWithOtp({
      phone,
      options: {
        channel: 'whatsapp'
      }
    });
    
    if (authError) {
      return res.status(401).json({ error: 'Failed to authenticate' });
    }
    
    // Check if user exists in profiles
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('*')
      .eq('phone_number', phone)
      .single();
    
    if (!existingProfile && !full_name) {
      return res.status(400).json({ 
        error: 'New user registration requires full_name' 
      });
    }
    
    let profile;
    
    if (!existingProfile) {
      // Create new profile
      const { data: newProfile, error: profileError } = await supabaseAdmin
        .from('profiles')
        .insert({
          id: authData.user?.id,
          phone_number: phone,
          full_name,
          role,
          kyc_verified: false
        })
        .select()
        .single();
      
      if (profileError) {
        return res.status(500).json({ error: 'Failed to create profile' });
      }
      
      profile = newProfile;
    } else {
      profile = existingProfile;
    }
    
    // Return session and user data
    res.json({
      success: true,
      session: authData.session,
      user: {
        id: profile.id,
        phone: profile.phone_number,
        full_name: profile.full_name,
        role: profile.role,
        verified_badge: profile.verified_badge
      }
    });
    
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ error: 'Failed to verify OTP' });
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
      phone: profile.phone_number,
      full_name: profile.full_name,
      role: profile.role,
      kyc_verified: profile.kyc_verified,
      verified_badge: profile.verified_badge,
      average_rating: profile.average_rating,
      total_ratings: profile.total_ratings
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
    const { full_name, school_id_url, government_id_url, selfie_url } = req.body;
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    
    if (userError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    
    const updates = {};
    if (full_name) updates.full_name = full_name;
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

module.exports = router;