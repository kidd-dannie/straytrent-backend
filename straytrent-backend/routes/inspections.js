const express = require('express');
const router = express.Router();
const { supabase } = require('../utils/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { sendInspectionReminderEmail } = require('../utils/email');

/**
 * Book an inspection (Student)
 * POST /api/inspections
 */
router.post('/', authenticate, requireRole('student'), async (req, res) => {
  try {
    const { listing_id, scheduled_at } = req.body;
    
    if (!listing_id || !scheduled_at) {
      return res.status(400).json({ error: 'Listing ID and scheduled time required' });
    }
    
    // Check if listing exists and is available
    const { data: listing, error: listingError } = await supabase
      .from('listings')
      .select('id, landlord_id, caretaker_id, title, address')
      .eq('id', listing_id)
      .eq('is_verified', true)
      .single();
    
    if (listingError || !listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    
    // Check for existing inspection conflicts
    const { data: existing, error: conflictError } = await supabase
      .from('inspections')
      .select('id')
      .eq('listing_id', listing_id)
      .eq('scheduled_at', scheduled_at)
      .eq('status', 'scheduled')
      .maybeSingle();
    
    if (existing) {
      return res.status(409).json({ error: 'Time slot already booked' });
    }
    
    // Create inspection
    const { data: inspection, error } = await supabase
      .from('inspections')
      .insert({
        listing_id,
        student_id: req.user.id,
        scheduled_at,
        no_show_deposit_amount: 1000,
        deposit_paid: false,
        status: 'scheduled'
      })
      .select()
      .single();
    
    if (error) throw error;
    
    // Schedule email reminder (2 hours before)
    const reminderTime = new Date(scheduled_at);
    reminderTime.setHours(reminderTime.getHours() - 2);
    
    if (reminderTime > new Date()) {
      setTimeout(async () => {
        await sendInspectionReminderEmail(
          req.user.email,
          listing.title,
          scheduled_at,
          listing.address
        );
      }, reminderTime - new Date());
    }
    
    res.status(201).json({ 
      success: true, 
      inspection,
      message: 'Inspection booked. Please pay the N1,000 no-show deposit to confirm.'
    });
    
  } catch (error) {
    console.error('Book inspection error:', error);
    res.status(500).json({ error: 'Failed to book inspection' });
  }
});

// ... (rest of the inspection routes remain the same as before, just using email instead of phone)
/**
 * Pay no-show deposit for inspection
 * POST /api/inspections/:id/pay-deposit
 */
router.post('/:id/pay-deposit', authenticate, requireRole('student'), async (req, res) => {
  try {
    const { id } = req.params;
    const { paystack_reference } = req.body;
    
    const { data: inspection, error } = await supabase
      .from('inspections')
      .update({
        deposit_paid: true,
        deposit_paid_at: new Date().toISOString()
      })
      .eq('id', id)
      .eq('student_id', req.user.id)
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ success: true, inspection });
    
  } catch (error) {
    console.error('Pay deposit error:', error);
    res.status(500).json({ error: 'Failed to record deposit payment' });
  }
});

/**
 * Confirm attendance (Landlord/Caretaker)
 * PATCH /api/inspections/:id/attendance
 */
router.patch('/:id/attendance', authenticate, requireRole('landlord', 'caretaker'), async (req, res) => {
  try {
    const { id } = req.params;
    const { attended, no_show_reason } = req.body;
    
    // Verify the inspection is for a listing owned/managed by this user
    const { data: inspection, error: fetchError } = await supabase
      .from('inspections')
      .select(`
        id,
        listing_id,
        listings!inner(landlord_id, caretaker_id)
      `)
      .eq('id', id)
      .single();
    
    if (fetchError) throw fetchError;
    
    const isAuthorized = inspection.listings.landlord_id === req.user.id || 
                         inspection.listings.caretaker_id === req.user.id;
    
    if (!isAuthorized) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { data: updated, error } = await supabase
      .from('inspections')
      .update({
        attended,
        attended_at: attended ? new Date().toISOString() : null,
        no_show_reason: !attended ? no_show_reason : null,
        status: attended ? 'completed' : 'no_show'
      })
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    
    // If no-show, forfeit deposit (in production, process refund logic)
    if (!attended && inspection.no_show_deposit_amount) {
      console.log(`Deposit forfeited for inspection ${id}`);
    }
    
    res.json({ success: true, inspection: updated });
    
  } catch (error) {
    console.error('Update attendance error:', error);
    res.status(500).json({ error: 'Failed to update attendance' });
  }
});

/**
 * Get my inspections (Student view)
 * GET /api/inspections/my
 */
router.get('/my', authenticate, requireRole('student'), async (req, res) => {
  try {
    const { data: inspections, error } = await supabase
      .from('inspections')
      .select(`
        *,
        listing:listings(title, address, area, unit_type, annual_rent)
      `)
      .eq('student_id', req.user.id)
      .order('scheduled_at', { ascending: true });
    
    if (error) throw error;
    
    res.json({ inspections });
    
  } catch (error) {
    console.error('Get my inspections error:', error);
    res.status(500).json({ error: 'Failed to fetch inspections' });
  }
});

/**
 * Get inspections for my listings (Landlord/Caretaker view)
 * GET /api/inspections/for-my-listings
 */
router.get('/for-my-listings', authenticate, requireRole('landlord', 'caretaker'), async (req, res) => {
  try {
    let query = supabase
      .from('inspections')
      .select(`
        *,
        listing:listings(title, address, area),
        student:profiles!student_id(full_name, phone_number)
      `);
    
    if (req.user.role === 'landlord') {
      query = query.in('listing_id', 
        supabase.from('listings').select('id').eq('landlord_id', req.user.id)
      );
    } else if (req.user.role === 'caretaker') {
      query = query.in('listing_id',
        supabase.from('listings').select('id').eq('caretaker_id', req.user.id)
      );
    }
    
    const { data: inspections, error } = await query.order('scheduled_at', { ascending: true });
    
    if (error) throw error;
    
    res.json({ inspections });
    
  } catch (error) {
    console.error('Get listings inspections error:', error);
    res.status(500).json({ error: 'Failed to fetch inspections' });
  }
});

module.exports = router;