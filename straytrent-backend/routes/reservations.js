const express = require('express');
const router = express.Router();
const { supabase } = require('../utils/supabase');
const { authenticate, requireRole } = require('../middleware/auth');

/**
 * Reserve a unit (72-hour hold)
 * POST /api/reservations
 */
router.post('/', authenticate, requireRole('student'), async (req, res) => {
  try {
    const { listing_id, inspection_id } = req.body;
    
    if (!listing_id) {
      return res.status(400).json({ error: 'Listing ID required' });
    }
    
    // Check if listing is available
    const { data: listing, error: listingError } = await supabase
      .from('listings')
      .select('id, status, annual_rent')
      .eq('id', listing_id)
      .single();
    
    if (listingError || listing.status !== 'available') {
      return res.status(400).json({ error: 'Listing is not available for reservation' });
    }
    
    // Create reservation with 72-hour hold
    const reservedUntil = new Date();
    reservedUntil.setHours(reservedUntil.getHours() + 72);
    
    const { data: reservation, error } = await supabase
      .from('reservations')
      .insert({
        listing_id,
        student_id: req.user.id,
        inspection_id,
        reserved_until: reservedUntil.toISOString(),
        status: 'active'
      })
      .select()
      .single();
    
    if (error) throw error;
    
    // Update listing status to reserved
    await supabase
      .from('listings')
      .update({ status: 'reserved' })
      .eq('id', listing_id);
    
    res.status(201).json({
      success: true,
      reservation,
      message: `Unit reserved until ${reservedUntil.toLocaleString()}. Pay reservation fee to confirm.`
    });
    
  } catch (error) {
    console.error('Create reservation error:', error);
    res.status(500).json({ error: 'Failed to create reservation' });
  }
});

/**
 * Pay reservation fee
 * POST /api/reservations/:id/pay-fee
 */
router.post('/:id/pay-fee', authenticate, requireRole('student'), async (req, res) => {
  try {
    const { id } = req.params;
    const { paystack_reference, amount } = req.body;
    
    const { data: reservation, error } = await supabase
      .from('reservations')
      .update({
        reservation_fee_paid: true,
        reservation_fee_amount: amount,
        reservation_fee_reference: paystack_reference,
        reservation_fee_paid_at: new Date().toISOString()
      })
      .eq('id', id)
      .eq('student_id', req.user.id)
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ success: true, reservation });
    
  } catch (error) {
    console.error('Pay reservation fee error:', error);
    res.status(500).json({ error: 'Failed to record reservation fee' });
  }
});

/**
 * Get my active reservations
 * GET /api/reservations/my
 */
router.get('/my', authenticate, requireRole('student'), async (req, res) => {
  try {
    const { data: reservations, error } = await supabase
      .from('reservations')
      .select(`
        *,
        listing:listings(title, address, area, unit_type, annual_rent, landlord_id),
        landlord:profiles!listings_landlord_id(full_name, phone_number)
      `)
      .eq('student_id', req.user.id)
      .in('status', ['active', 'converted_to_lease'])
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    res.json({ reservations });
    
  } catch (error) {
    console.error('Get my reservations error:', error);
    res.status(500).json({ error: 'Failed to fetch reservations' });
  }
});

/**
 * Cancel reservation
 * DELETE /api/reservations/:id
 */
router.delete('/:id', authenticate, requireRole('student'), async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    
    const { data: reservation, error } = await supabase
      .from('reservations')
      .update({
        status: 'cancelled_by_student',
        cancelled_at: new Date().toISOString(),
        cancellation_reason: reason
      })
      .eq('id', id)
      .eq('student_id', req.user.id)
      .select('listing_id')
      .single();
    
    if (error) throw error;
    
    // Release the listing back to available
    await supabase
      .from('listings')
      .update({ status: 'available' })
      .eq('id', reservation.listing_id);
    
    res.json({ success: true, message: 'Reservation cancelled' });
    
  } catch (error) {
    console.error('Cancel reservation error:', error);
    res.status(500).json({ error: 'Failed to cancel reservation' });
  }
});

module.exports = router;