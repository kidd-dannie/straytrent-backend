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
    const { email, code, full_name, role = 'student', phone_number } = req.body;
    
    if (!email || !code) {
      return res.status(400).json({ error: 'Email and OTP required' });
    }
    
    // Verify OTP
    await verifyOTP(email, code, 'login');
    
    // Check if user already exists in Supabase Auth
    const { data: { users }, error: listError } = await supabaseAdmin.auth.admin.listUsers();
    
    if (listError) {
      console.error('List users error:', listError);
    }
    
    let existingAuthUser = users?.find(u => u.email === email);
    let isNewUser = false;
    let authUser;
    let tempPassword = null; // ✅ FIX: Declare tempPassword here
    
    if (!existingAuthUser) {
      // Create new user in Supabase Auth
      const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
        email: email,
        email_confirm: true,
        user_metadata: { 
          full_name: full_name || email.split('@')[0],
          role: role 
        }
      });
      
      if (createError) {
        console.error('Create user error:', createError);
        return res.status(500).json({ error: 'Failed to create user: ' + createError.message });
      }
      
      authUser = newUser.user;
      isNewUser = true;
      
      // ✅ Generate temp password for new user
      tempPassword = generateOTP() + '@Temp123';
      const { error: updatePassError } = await supabaseAdmin.auth.admin.updateUserById(
        authUser.id,
        { password: tempPassword }
      );
      
      if (updatePassError) {
        console.error('Password update error:', updatePassError);
        // Continue anyway - we'll use magic link
      }
    } else {
      authUser = existingAuthUser;
    }
    
    // Check if profile exists
    const { data: existingProfile, error: profileCheckError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', authUser.id)
      .single();
    
    let profile;
    
    if (!existingProfile) {
      // Create new profile
      const profileData = {
        id: authUser.id,
        email: email,
        full_name: full_name || authUser.user_metadata?.full_name || email.split('@')[0],
        role: role,
        kyc_verified: false
      };
      
      // Only add phone_number if provided
      if (phone_number) {
        profileData.phone_number = phone_number;
      }
      
      const { data: newProfile, error: profileError } = await supabaseAdmin
        .from('profiles')
        .insert(profileData)
        .select()
        .single();
      
      if (profileError) {
        console.error('Profile creation error:', profileError);
        return res.status(500).json({ error: 'Failed to create profile' });
      }
      
      profile = newProfile;
      
      // Send welcome email only for new users
      if (isNewUser) {
        await sendWelcomeEmail(email, profile.full_name, role);
      }
    } else {
      profile = existingProfile;
      
      // Update email if missing
      if (!profile.email) {
        await supabaseAdmin
          .from('profiles')
          .update({ email: email })
          .eq('id', profile.id);
        profile.email = email;
      }
      
      // Update phone number if provided and not set
      if (phone_number && !profile.phone_number) {
        await supabaseAdmin
          .from('profiles')
          .update({ phone_number: phone_number })
          .eq('id', profile.id);
        profile.phone_number = phone_number;
      }
    }
    
    // ✅ FIX: Use tempPassword only if it exists and user is new
    let session = null;
    
    if (isNewUser && tempPassword) {
      // Try to sign in with the temporary password
      const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
        email: email,
        password: tempPassword
      });
      
      if (!signInError && signInData.session) {
        session = signInData.session;
      } else {
        console.log('Sign in failed, sending magic link instead');
        // Send magic link as fallback
        const { error: magicError } = await supabase.auth.signInWithOtp({
          email: email,
          options: {
            shouldCreateUser: false
          }
        });
        
        if (!magicError) {
          session = { 
            access_token: 'use-magic-link', 
            message: 'Check your email for magic link to login' 
          };
        }
      }
    } else if (!isNewUser) {
      // For existing users, send magic link
      const { error: magicError } = await supabase.auth.signInWithOtp({
        email: email,
        options: {
          shouldCreateUser: false
        }
      });
      
      if (!magicError) {
        session = { 
          access_token: 'use-magic-link', 
          message: 'Check your email for magic link to login' 
        };
      }
    }
    
    res.json({
      success: true,
      session: session,
      user: {
        id: profile.id,
        email: profile.email,
        full_name: profile.full_name,
        role: profile.role,
        phone_number: profile.phone_number,
        verified_badge: profile.verified_badge,
        kyc_verified: profile.kyc_verified 
      },
      message: isNewUser ? 'Account created successfully! Check your email to login.' : 'Logged in successfully! Check your email for magic link.'
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
    
    // Try to get user from token
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();
    
    if (profileError && profileError.code !== 'PGRST116') {
      return res.status(404).json({ error: 'Profile not found' });
    }
    
    res.json({
      id: user.id,
      email: user.email,
      full_name: profile?.full_name || user.user_metadata?.full_name,
      role: profile?.role || 'student',
      phone_number: profile?.phone_number,
      kyc_verified: profile?.kyc_verified,
      verified_badge: profile?.verified_badge,
      average_rating: profile?.average_rating,
      total_ratings: profile?.total_ratings
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
    
    // Check if profile exists
    const { data: existingProfile } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('id', user.id)
      .single();
    
    let result;
    
    if (!existingProfile) {
      // Create profile if it doesn't exist
      const { data: newProfile, error: insertError } = await supabaseAdmin
        .from('profiles')
        .insert({
          id: user.id,
          email: user.email,
          full_name: full_name || user.email.split('@')[0],
          role: 'student',
          ...updates
        })
        .select()
        .single();
      
      if (insertError) throw insertError;
      result = newProfile;
    } else {
      // Update existing profile
      const { data: updatedProfile, error: updateError } = await supabaseAdmin
        .from('profiles')
        .update(updates)
        .eq('id', user.id)
        .select()
        .single();
      
      if (updateError) throw updateError;
      result = updatedProfile;
    }
    
    res.json({ success: true, profile: result });
    
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