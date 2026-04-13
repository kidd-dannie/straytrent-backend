const express = require('express');
const router = express.Router();
const { supabase, supabaseAdmin } = require('../utils/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { sendCaretakerPingEmail } = require('../utils/email');

/**
 * Get all available listings (student view)
 * GET /api/listings
 */
router.get('/', authenticate, async (req, res) => {
  try {
    let query = supabase
      .from('listings')
      .select(`
        *,
        landlord:profiles!landlord_id(full_name, email, average_rating),
        caretaker:profiles!caretaker_id(full_name, email),
        photos:listing_photos(photo_url, is_primary)
      `)
      .eq('is_verified', true)
      .eq('status', 'available');
    
    // Apply filters
    const { area, min_price, max_price, max_walk_time, unit_type } = req.query;
    
    if (area) query = query.eq('area', area);
    if (unit_type) query = query.eq('unit_type', unit_type);
    if (min_price) query = query.gte('annual_rent', min_price);
    if (max_price) query = query.lte('annual_rent', max_price);
    if (max_walk_time) query = query.lte('walk_time_to_gate_minutes', max_walk_time);
    
    const { data: listings, error } = await query;
    
    if (error) throw error;
    
    res.json({ listings, count: listings?.length || 0 });
    
  } catch (error) {
    console.error('Get listings error:', error);
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

/**
 * Get single listing by ID
 * GET /api/listings/:id
 */
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: listing, error } = await supabase
      .from('listings')
      .select(`
        *,
        landlord:profiles!landlord_id(full_name, email, average_rating, verified_badge),
        caretaker:profiles!caretaker_id(full_name, email),
        photos:listing_photos(photo_url, is_primary, "order"),
        availability_log:availability_log(*)
      `)
      .eq('id', id)
      .single();
    
    if (error) throw error;
    
    // Increment view count
    await supabase
      .from('listings')
      .update({ view_count: (listing.view_count || 0) + 1 })
      .eq('id', id);
    
    res.json({ listing });
    
  } catch (error) {
    console.error('Get listing error:', error);
    res.status(500).json({ error: 'Failed to fetch listing' });
  }
});

/**
 * Create new listing (Landlord/Caretaker only)
 * POST /api/listings
 */
router.post('/', authenticate, requireRole('landlord', 'caretaker'), async (req, res) => {
  try {
    const {
      title, description, unit_type, address, gps_coordinates,
      walk_time_to_gate_minutes, area, annual_rent, security_deposit,
      utilities, rules, caretaker_id
    } = req.body;
    
    // Validate required fields
    if (!title || !unit_type || !address || !area || !annual_rent) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const listingData = {
      landlord_id: req.user.id,
      title,
      description,
      unit_type,
      address,
      gps_coordinates: gps_coordinates ? `POINT(${gps_coordinates.lng} ${gps_coordinates.lat})` : null,
      walk_time_to_gate_minutes,
      area,
      annual_rent,
      security_deposit,
      utilities: utilities || {},
      rules: rules || {},
      status: 'pending_verification',
      last_confirmed_at: new Date().toISOString(),
      needs_confirmation: false
    };
    
    // If caretaker is creating on behalf of landlord
    if (req.user.role === 'caretaker') {
      listingData.caretaker_id = req.user.id;
    }
    
    if (caretaker_id && req.user.role === 'landlord') {
      listingData.caretaker_id = caretaker_id;
    }
    
    const { data: listing, error } = await supabase
      .from('listings')
      .insert(listingData)
      .select()
      .single();
    
    if (error) throw error;
    
    res.status(201).json({ 
      success: true, 
      listing,
      message: 'Listing created. Awaiting verification.' 
    });
    
  } catch (error) {
    console.error('Create listing error:', error);
    res.status(500).json({ error: 'Failed to create listing' });
  }
});

/**
 * Update listing status (availability)
 * PATCH /api/listings/:id/status
 */
router.patch('/:id/status', authenticate, requireRole('landlord', 'caretaker'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    // Verify ownership
    const { data: listing, error: fetchError } = await supabase
      .from('listings')
      .select('landlord_id, caretaker_id')
      .eq('id', id)
      .single();
    
    if (fetchError) throw fetchError;
    
    const isOwner = listing.landlord_id === req.user.id || listing.caretaker_id === req.user.id;
    
    if (!isOwner) {
      return res.status(403).json({ error: 'Not authorized to update this listing' });
    }
    
    const { data: updated, error } = await supabase
      .from('listings')
      .update({ 
        status, 
        last_confirmed_at: new Date().toISOString(),
        needs_confirmation: false
      })
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ success: true, listing: updated });
    
  } catch (error) {
    console.error('Update listing status error:', error);
    res.status(500).json({ error: 'Failed to update listing' });
  }
});

/**
 * Handle caretaker 14-day ping response (Email webhook)
 * GET /api/listings/:id/ping (from email link)
 * POST /api/listings/webhook/caretaker-ping (API endpoint)
 */
router.get('/:id/ping', async (req, res) => {
  try {
    const { id } = req.params;
    const { response } = req.query;
    
    let newStatus;
    
    switch (response) {
      case 'yes':
        newStatus = 'available';
        break;
      case 'no':
        newStatus = 'taken';
        break;
      default:
        return res.status(400).send('Invalid response. Please use "yes" or "no".');
    }
    
    // Get current status before update
    const { data: listing } = await supabase
      .from('listings')
      .select('status')
      .eq('id', id)
      .single();
    
    // Update listing
    const { error } = await supabase
      .from('listings')
      .update({
        status: newStatus,
        last_confirmed_at: new Date().toISOString(),
        needs_confirmation: false,
        confirmation_count: supabase.rpc('increment', { row_id: id })
      })
      .eq('id', id);
    
    if (error) throw error;
    
    // Log the response
    await supabase
      .from('availability_log')
      .insert({
        listing_id: id,
        ping_sent_at: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
        response_received_at: new Date().toISOString(),
        response: response === 'yes' ? 'yes' : 'no',
        status_before: listing?.status,
        status_after: newStatus
      });
    
    res.send(`
      <html>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h2>✅ Status Updated!</h2>
          <p>This unit has been marked as <strong>${newStatus}</strong>.</p>
          <p>Thank you for keeping StraytRent inventory fresh!</p>
          <a href="${process.env.FRONTEND_URL}/dashboard">Return to Dashboard</a>
        </body>
      </html>
    `);
    
  } catch (error) {
    console.error('Ping response error:', error);
    res.status(500).send('Error updating status. Please try again.');
  }
});

/**
 * Get listings managed by current caretaker/landlord
 * GET /api/listings/my/listings
 */
router.get('/my/listings', authenticate, requireRole('landlord', 'caretaker'), async (req, res) => {
  try {
    let query = supabase
      .from('listings')
      .select(`
        *,
        photos:listing_photos(photo_url, is_primary)
      `);
    
    if (req.user.role === 'landlord') {
      query = query.eq('landlord_id', req.user.id);
    } else if (req.user.role === 'caretaker') {
      query = query.eq('caretaker_id', req.user.id);
    }
    
    const { data: listings, error } = await query;
    
    if (error) throw error;
    
    res.json({ listings });
    
  } catch (error) {
    console.error('Get my listings error:', error);
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

module.exports = router;