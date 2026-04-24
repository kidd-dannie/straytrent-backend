const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

// Admin client with service role (bypasses RLS)
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// Public client (respects RLS)
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Helper function to generate OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Helper function to store OTP in database
async function storeOTP(email, code, purpose = 'login') {
  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + 10); // 10 minutes expiry
  
  const { data, error } = await supabaseAdmin
    .from('otp_codes')
    .insert({
      email,
      code,
      purpose,
      expires_at: expiresAt.toISOString(),
      used: false
    })
    .select()
    .single();
  
  if (error) throw error;
  return data;
}

// Helper function to verify OTP
async function verifyOTP(email, code, purpose = 'login') {
  // Find valid OTP
  const { data, error } = await supabaseAdmin
    .from('otp_codes')
    .select('*')
    .eq('email', email)
    .eq('code', code)
    .eq('purpose', purpose)
    .eq('used', false)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  
  if (error || !data) {
    throw new Error('Invalid or expired OTP');
  }
  
  // Mark as used
  await supabaseAdmin
    .from('otp_codes')
    .update({ used: true })
    .eq('id', data.id);
  
  return data;
}

// Helper function to get user profile by email
async function getProfileByEmail(email) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('email', email)
    .single();
  
  if (error) return null;
  return data;
}

// Helper function to get user profile by ID
async function getProfileById(id) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', id)
    .single();
  
  if (error) return null;
  return data;
}

module.exports = { 
  supabase, 
  supabaseAdmin, 
  generateOTP, 
  storeOTP, 
  verifyOTP,
  getProfileByEmail,
  getProfileById
};