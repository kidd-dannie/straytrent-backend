const express = require('express');
const router = express.Router();
const { supabase } = require('../utils/supabase');
const { authenticate, requireRole } = require('../middleware/auth');

/**
 * Create tenancy agreement from reservation
 * POST /api/tenancies
 */
router.post('/', authenticate, requireRole('student'), async (req, res) => {
  try {
    const { reservation_id, start_date, end_date } = req.body;
    
    // Get reservation details
    const { data: reservation, error: resError } = await supabase
      .from('reservations')
      .select(`
        *,
        listing:listings(
          id, 
          landlord_id, 
          annual_rent, 
          security_deposit,
          platform_fee_percent
        )
      `)
      .eq('id', reservation_id)
      .eq('student_id', req.user.id)
      .single();
    
    if (resError || !reservation) {
      return res.status(404).json({ error: 'Reservation not found' });
    }
    
    // Create tenancy agreement
    const { data: tenancy, error } = await supabase
      .from('tenancy_agreements')
      .insert({
        listing_id: reservation.listing.id,
        student_id: req.user.id,
        landlord_id: reservation.listing.landlord_id,
        reservation_id,
        annual_rent_agreed: reservation.listing.annual_rent,
        start_date,
        end_date,
        security_deposit: reservation.listing.security_deposit,
        status: 'pending_student',
        warranty_end_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
      })
      .select()
      .single();
    
    if (error) throw error;
    
    // Update reservation status
    await supabase
      .from('reservations')
      .update({ status: 'converted_to_lease' })
      .eq('id', reservation_id);
    
    res.status(201).json({
      success: true,
      tenancy,
      message: 'Tenancy agreement created. Please review and sign.'
    });
    
  } catch (error) {
    console.error('Create tenancy error:', error);
    res.status(500).json({ error: 'Failed to create tenancy agreement' });
  }
});

/**
 * Sign tenancy agreement (Student or Landlord)
 * POST /api/tenancies/:id/sign
 */
router.post('/:id/sign', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { signature_data } = req.body; // In production, this would be from e-sign service
    
    const { data: tenancy, error: fetchError } = await supabase
      .from('tenancy_agreements')
      .select('*')
      .eq('id', id)
      .single();
    
    if (fetchError) throw fetchError;
    
    const updateData = {};
    const isStudent = tenancy.student_id === req.user.id;
    const isLandlord = tenancy.landlord_id === req.user.id;
    
    if (!isStudent && !isLandlord) {
      return res.status(403).json({ error: 'Not authorized to sign this agreement' });
    }
    
    if (isStudent) {
      updateData.student_signed_at = new Date().toISOString();
    }
    if (isLandlord) {
      updateData.landlord_signed_at = new Date().toISOString();
    }
    
    // If both have signed, activate the agreement
    const willBeActive = (isStudent && tenancy.landlord_signed_at) || 
                         (isLandlord && tenancy.student_signed_at);
    
    if (willBeActive) {
      updateData.status = 'active';
      updateData.activated_at = new Date().toISOString();
    } else if (isStudent && !tenancy.landlord_signed_at) {
      updateData.status = 'pending_landlord';
    } else if (isLandlord && !tenancy.student_signed_at) {
      updateData.status = 'pending_student';
    }
    
    const { data: updated, error } = await supabase
      .from('tenancy_agreements')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({
      success: true,
      tenancy: updated,
      message: willBeActive ? 'Agreement activated!' : 'Signature recorded. Waiting for other party.'
    });
    
  } catch (error) {
    console.error('Sign tenancy error:', error);
    res.status(500).json({ error: 'Failed to sign agreement' });
  }
});

/**
 * Get my tenancies
 * GET /api/tenancies/my
 */
router.get('/my', authenticate, async (req, res) => {
  try {
    const { data: tenancies, error } = await supabase
      .from('tenancy_agreements')
      .select(`
        *,
        listing:listings(title, address, area, unit_type),
        student:profiles!student_id(full_name, phone_number),
        landlord:profiles!landlord_id(full_name, phone_number),
        escrow:escrow_transactions(*)
      `)
      .or(`student_id.eq.${req.user.id},landlord_id.eq.${req.user.id}`)
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    res.json({ tenancies });
    
  } catch (error) {
    console.error('Get my tenancies error:', error);
    res.status(500).json({ error: 'Failed to fetch tenancies' });
  }
});

/**
 * Submit handover checklist
 * POST /api/tenancies/:id/handover
 */
router.post('/:id/handover', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      meter_reading_electricity,
      meter_reading_water,
      keys_received,
      photos,
      defects
    } = req.body;
    
    const { data: tenancy, error: fetchError } = await supabase
      .from('tenancy_agreements')
      .select('student_id, landlord_id')
      .eq('id', id)
      .single();
    
    if (fetchError) throw fetchError;
    
    const isStudent = tenancy.student_id === req.user.id;
    const isLandlord = tenancy.landlord_id === req.user.id;
    
    if (!isStudent && !isLandlord) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    // Check if handover checklist exists
    let { data: checklist, error: checkError } = await supabase
      .from('handover_checklists')
      .select('*')
      .eq('tenancy_agreement_id', id)
      .single();
    
    const updateData = {};
    
    if (isStudent) {
      updateData.student_move_in_signed_at = new Date().toISOString();
      updateData.move_in_meter_reading_electricity = meter_reading_electricity;
      updateData.move_in_meter_reading_water = meter_reading_water;
      updateData.move_in_keys_received = keys_received;
      updateData.move_in_photos = photos;
      updateData.move_in_defects = defects;
    }
    
    if (isLandlord) {
      updateData.landlord_move_in_signed_at = new Date().toISOString();
    }
    
    if (!checklist) {
      // Create new checklist
      const { data: newChecklist, error: createError } = await supabase
        .from('handover_checklists')
        .insert({
          tenancy_agreement_id: id,
          ...updateData
        })
        .select()
        .single();
      
      if (createError) throw createError;
      checklist = newChecklist;
    } else {
      // Update existing
      const { data: updated, error: updateError } = await supabase
        .from('handover_checklists')
        .update(updateData)
        .eq('id', checklist.id)
        .select()
        .single();
      
      if (updateError) throw updateError;
      checklist = updated;
    }
    
    // If both have signed, complete handover and release escrow
    if (checklist.student_move_in_signed_at && checklist.landlord_move_in_signed_at) {
      await supabase
        .from('handover_checklists')
        .update({ move_in_completed_at: new Date().toISOString() })
        .eq('id', checklist.id);
      
      // Trigger escrow release (in production, call Paystack API)
      await supabase
        .from('escrow_transactions')
        .update({ 
          status: 'released_to_landlord',
          released_at: new Date().toISOString()
        })
        .eq('tenancy_agreement_id', id);
    }
    
    res.json({
      success: true,
      checklist,
      message: 'Handover checklist submitted'
    });
    
  } catch (error) {
    console.error('Handover error:', error);
    res.status(500).json({ error: 'Failed to submit handover checklist' });
  }
});

/**
 * Submit review/rating
 * POST /api/tenancies/:id/review
 */
router.post('/:id/review', authenticate, requireRole('student'), async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, review, categories } = req.body;
    
    const { data: tenancy, error: fetchError } = await supabase
      .from('tenancy_agreements')
      .select('student_id, landlord_id, listing_id')
      .eq('id', id)
      .single();
    
    if (fetchError) throw fetchError;
    
    if (tenancy.student_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to review this tenancy' });
    }
    
    const { data: reviewData, error } = await supabase
      .from('ratings_reviews')
      .insert({
        tenancy_agreement_id: id,
        rater_id: req.user.id,
        rated_id: tenancy.landlord_id,
        rater_role_at_time: 'student',
        rating,
        review,
        categories: categories || {},
        is_verified_purchase: true
      })
      .select()
      .single();
    
    if (error) throw error;
    
    res.status(201).json({
      success: true,
      review: reviewData,
      message: 'Thank you for your review!'
    });
    
  } catch (error) {
    console.error('Submit review error:', error);
    res.status(500).json({ error: 'Failed to submit review' });
  }
});

module.exports = router;