-- =====================================================
-- STRAYTRENT - COMPLETE DATABASE SCHEMA
-- PostgreSQL via Supabase
-- =====================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =====================================================
-- 1. PROFILES TABLE (extends Supabase Auth)
-- =====================================================
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('student', 'landlord', 'caretaker', 'agent')),
  full_name TEXT NOT NULL,
  phone_number TEXT UNIQUE NOT NULL,
  
  -- KYC fields
  school_id_url TEXT,
  government_id_url TEXT,
  bvn TEXT,
  selfie_url TEXT,
  ownership_docs_url TEXT,
  authorisation_letter_url TEXT,
  
  -- Verification status
  kyc_verified BOOLEAN DEFAULT FALSE,
  verified_badge BOOLEAN DEFAULT FALSE,
  is_founding_agent BOOLEAN DEFAULT FALSE,
  
  -- Ratings aggregate
  average_rating DECIMAL(3,2) DEFAULT 0,
  total_ratings INTEGER DEFAULT 0,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 2. LISTINGS TABLE
-- =====================================================
CREATE TABLE public.listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Ownership
  landlord_id UUID REFERENCES public.profiles(id) NOT NULL,
  caretaker_id UUID REFERENCES public.profiles(id),
  agent_id UUID REFERENCES public.profiles(id),
  
  -- Basic info
  title TEXT NOT NULL,
  description TEXT,
  unit_type TEXT NOT NULL CHECK (unit_type IN ('self-con', 'mini-flat', 'hostel-bed', 'shared-room', 'face-me-i-face-you')),
  
  -- Location
  address TEXT NOT NULL,
  gps_coordinates GEOGRAPHY(POINT, 4326),
  walk_time_to_gate_minutes INTEGER,
  area TEXT NOT NULL CHECK (area IN ('Onike', 'Abule Oja', 'Akoka', 'Iwaya', 'Bariga', 'Sabo', 'Other')),
  
  -- Pricing
  annual_rent NUMERIC(12,2) NOT NULL,
  platform_fee_percent NUMERIC(5,2) DEFAULT 6.0,
  security_deposit NUMERIC(12,2),
  
  -- Utilities & rules
  utilities JSONB DEFAULT '{"has_generator": false, "has_water_tank": false, "has_own_meter": false}'::jsonb,
  rules JSONB DEFAULT '{}'::jsonb,
  
  -- Status & freshness
  status TEXT DEFAULT 'pending_verification' 
    CHECK (status IN ('pending_verification', 'available', 'reserved', 'taken', 'unconfirmed', 'deprioritised')),
  last_confirmed_at TIMESTAMPTZ,
  needs_confirmation BOOLEAN DEFAULT TRUE,
  confirmation_count INTEGER DEFAULT 0,
  
  -- Verification
  is_verified BOOLEAN DEFAULT FALSE,
  verified_by UUID REFERENCES public.profiles(id),
  verified_at TIMESTAMPTZ,
  verification_notes TEXT,
  
  -- Views & engagement
  view_count INTEGER DEFAULT 0,
  inspection_count INTEGER DEFAULT 0,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 3. LISTING PHOTOS
-- =====================================================
CREATE TABLE public.listing_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES public.listings(id) ON DELETE CASCADE,
  photo_url TEXT NOT NULL,
  is_primary BOOLEAN DEFAULT FALSE,
  geotagged_at TIMESTAMPTZ,
  "order" INTEGER DEFAULT 0,
  uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 4. AVAILABILITY LOG (14-day ping tracking)
-- =====================================================
CREATE TABLE public.availability_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES public.listings(id) ON DELETE CASCADE,
  ping_sent_at TIMESTAMPTZ,
  ping_channel TEXT DEFAULT 'whatsapp',
  response_received_at TIMESTAMPTZ,
  response TEXT CHECK (response IN ('yes', 'no', 'someone_moved_in')),
  status_before TEXT,
  status_after TEXT,
  changed_by_system BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 5. INSPECTIONS
-- =====================================================
CREATE TABLE public.inspections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES public.listings(id) NOT NULL,
  student_id UUID REFERENCES public.profiles(id) NOT NULL,
  
  scheduled_at TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER DEFAULT 30,
  
  no_show_deposit_amount NUMERIC(10,2) DEFAULT 1000,
  deposit_paid BOOLEAN DEFAULT FALSE,
  deposit_paid_at TIMESTAMPTZ,
  deposit_refunded BOOLEAN DEFAULT FALSE,
  deposit_refunded_at TIMESTAMPTZ,
  
  attended BOOLEAN DEFAULT FALSE,
  attended_at TIMESTAMPTZ,
  no_show_reason TEXT,
  
  reminder_sent_at TIMESTAMPTZ,
  reminder_count INTEGER DEFAULT 0,
  
  student_feedback TEXT,
  landlord_feedback TEXT,
  
  status TEXT DEFAULT 'scheduled' 
    CHECK (status IN ('scheduled', 'completed', 'cancelled_by_student', 'cancelled_by_landlord', 'no_show')),
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 6. RESERVATIONS (72-hour hold)
-- =====================================================
CREATE TABLE public.reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES public.listings(id) NOT NULL,
  student_id UUID REFERENCES public.profiles(id) NOT NULL,
  inspection_id UUID REFERENCES public.inspections(id),
  
  reserved_until TIMESTAMPTZ NOT NULL,
  reservation_fee_paid BOOLEAN DEFAULT FALSE,
  reservation_fee_amount NUMERIC(10,2),
  reservation_fee_reference TEXT,
  reservation_fee_paid_at TIMESTAMPTZ,
  
  status TEXT DEFAULT 'active'
    CHECK (status IN ('active', 'converted_to_lease', 'expired', 'cancelled_by_student', 'cancelled_by_landlord')),
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ GENERATED ALWAYS AS (reserved_until) STORED
);

-- =====================================================
-- 7. TENANCY AGREEMENTS
-- =====================================================
CREATE TABLE public.tenancy_agreements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES public.listings(id) NOT NULL,
  student_id UUID REFERENCES public.profiles(id) NOT NULL,
  landlord_id UUID REFERENCES public.profiles(id) NOT NULL,
  reservation_id UUID REFERENCES public.reservations(id),
  
  annual_rent_agreed NUMERIC(12,2) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  security_deposit NUMERIC(12,2),
  
  -- E-signatures
  student_signed_at TIMESTAMPTZ,
  landlord_signed_at TIMESTAMPTZ,
  signed_pdf_url TEXT,
  esign_reference TEXT,
  
  -- Legal
  legal_fee_applied NUMERIC(10,2) DEFAULT 0,
  legal_fee_paid BOOLEAN DEFAULT FALSE,
  
  -- Warranty (PRD: 5-7 days)
  warranty_end_date DATE,
  warranty_claimed BOOLEAN DEFAULT FALSE,
  
  status TEXT DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_landlord', 'pending_student', 'active', 'completed', 'terminated', 'disputed')),
  
  terminated_at TIMESTAMPTZ,
  termination_reason TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  activated_at TIMESTAMPTZ
);

-- =====================================================
-- 8. ESCROW TRANSACTIONS
-- =====================================================
CREATE TABLE public.escrow_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenancy_agreement_id UUID REFERENCES public.tenancy_agreements(id) NOT NULL,
  
  paystack_reference TEXT UNIQUE NOT NULL,
  paystack_access_code TEXT,
  paystack_authorization_url TEXT,
  
  total_amount NUMERIC(12,2) NOT NULL,
  platform_fee_amount NUMERIC(12,2) NOT NULL,
  net_to_landlord NUMERIC(12,2) NOT NULL,
  
  status TEXT DEFAULT 'awaiting_payment'
    CHECK (status IN ('awaiting_payment', 'held_in_escrow', 'released_to_landlord', 'refunded', 'disputed')),
  
  student_paid_at TIMESTAMPTZ,
  funds_held_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  
  dispute_initiated_at TIMESTAMPTZ,
  dispute_resolved_at TIMESTAMPTZ,
  dispute_resolution_notes TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 9. HANDOVER CHECKLISTS
-- =====================================================
CREATE TABLE public.handover_checklists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenancy_agreement_id UUID REFERENCES public.tenancy_agreements(id) NOT NULL,
  
  -- Move-in
  move_in_meter_reading_electricity NUMERIC(10,2),
  move_in_meter_reading_water NUMERIC(10,2),
  move_in_keys_received INTEGER,
  move_in_photos JSONB,
  move_in_defects TEXT,
  
  student_move_in_signed_at TIMESTAMPTZ,
  landlord_move_in_signed_at TIMESTAMPTZ,
  
  -- Move-out
  move_out_meter_reading_electricity NUMERIC(10,2),
  move_out_meter_reading_water NUMERIC(10,2),
  move_out_keys_returned INTEGER,
  move_out_photos JSONB,
  move_out_defects TEXT,
  
  student_move_out_signed_at TIMESTAMPTZ,
  landlord_move_out_signed_at TIMESTAMPTZ,
  
  deposit_returned_amount NUMERIC(12,2),
  deposit_returned_at TIMESTAMPTZ,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  move_in_completed_at TIMESTAMPTZ,
  move_out_completed_at TIMESTAMPTZ
);

-- =====================================================
-- 10. COMMISSION PAYOUTS
-- =====================================================
CREATE TABLE public.commission_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenancy_agreement_id UUID REFERENCES public.tenancy_agreements(id) NOT NULL,
  
  recipient_id UUID REFERENCES public.profiles(id) NOT NULL,
  recipient_type TEXT CHECK (recipient_type IN ('caretaker', 'agent')),
  
  commission_amount NUMERIC(12,2) NOT NULL,
  commission_percent NUMERIC(5,2),
  commission_type TEXT CHECK (commission_type IN ('onboarding', 'deal_close', 'volume_bonus')),
  
  paid_out BOOLEAN DEFAULT FALSE,
  paid_out_at TIMESTAMPTZ,
  paystack_transfer_reference TEXT,
  transfer_status TEXT,
  
  is_founding_agent BOOLEAN DEFAULT FALSE,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 11. RATINGS & REVIEWS
-- =====================================================
CREATE TABLE public.ratings_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenancy_agreement_id UUID REFERENCES public.tenancy_agreements(id) NOT NULL,
  
  rater_id UUID REFERENCES public.profiles(id) NOT NULL,
  rated_id UUID REFERENCES public.profiles(id) NOT NULL,
  rater_role_at_time TEXT,
  
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  review TEXT,
  
  categories JSONB DEFAULT '{"accuracy": 0, "communication": 0, "cleanliness": 0, "value": 0}'::jsonb,
  
  is_verified_purchase BOOLEAN DEFAULT TRUE,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(tenancy_agreement_id, rater_id, rated_id)
);

-- =====================================================
-- 12. DISPUTES
-- =====================================================
CREATE TABLE public.disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenancy_agreement_id UUID REFERENCES public.tenancy_agreements(id) NOT NULL,
  raised_by UUID REFERENCES public.profiles(id) NOT NULL,
  
  dispute_type TEXT CHECK (dispute_type IN ('material_misrepresentation', 'maintenance', 'payment', 'security_deposit', 'other')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence_urls JSONB,
  
  status TEXT DEFAULT 'open'
    CHECK (status IN ('open', 'under_review', 'resolved_student', 'resolved_landlord', 'escalated', 'closed')),
  
  assigned_to UUID REFERENCES public.profiles(id),
  resolution_notes TEXT,
  resolved_at TIMESTAMPTZ,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 13. OFF-PLATFORM SUSPICIONS (Bypass detection)
-- =====================================================
CREATE TABLE public.off_platform_suspicions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES public.listings(id),
  student_id UUID REFERENCES public.profiles(id),
  landlord_id UUID REFERENCES public.profiles(id),
  
  suspicion_reason TEXT CHECK (suspicion_reason IN 
    ('mystery_shopping_report', 
     'inspection_no_show_then_lease_elsewhere',
     'landlord_requested_offline_payment',
     'rapid_reservation_cancellation',
     'agent_reported_bypass')),
  
  description TEXT,
  reported_by UUID REFERENCES public.profiles(id),
  evidence JSONB,
  
  is_confirmed BOOLEAN DEFAULT FALSE,
  action_taken TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 14. NOTIFICATIONS LOG
-- =====================================================
CREATE TABLE public.notifications_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID REFERENCES public.profiles(id),
  recipient_phone TEXT,
  notification_type TEXT CHECK (notification_type IN ('otp', 'reminder', 'status_update', 'alert', 'marketing')),
  channel TEXT CHECK (channel IN ('whatsapp', 'sms', 'email', 'push')),
  title TEXT,
  message TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'failed')),
  provider_reference TEXT,
  error_message TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================
CREATE INDEX idx_profiles_role ON public.profiles(role);
CREATE INDEX idx_profiles_phone ON public.profiles(phone_number);
CREATE INDEX idx_profiles_verified_badge ON public.profiles(verified_badge);

CREATE INDEX idx_listings_area ON public.listings(area);
CREATE INDEX idx_listings_price ON public.listings(annual_rent);
CREATE INDEX idx_listings_walk_time ON public.listings(walk_time_to_gate_minutes);
CREATE INDEX idx_listings_status ON public.listings(status);
CREATE INDEX idx_listings_verified ON public.listings(is_verified);
CREATE INDEX idx_listings_caretaker ON public.listings(caretaker_id);
CREATE INDEX idx_listings_landlord ON public.listings(landlord_id);

CREATE INDEX idx_inspections_listing ON public.inspections(listing_id);
CREATE INDEX idx_inspections_student ON public.inspections(student_id);
CREATE INDEX idx_inspections_scheduled ON public.inspections(scheduled_at);
CREATE INDEX idx_inspections_status ON public.inspections(status);

CREATE INDEX idx_reservations_listing ON public.reservations(listing_id);
CREATE INDEX idx_reservations_student ON public.reservations(student_id);
CREATE INDEX idx_reservations_active ON public.reservations(status, reserved_until);

CREATE INDEX idx_tenancy_agreements_student ON public.tenancy_agreements(student_id);
CREATE INDEX idx_tenancy_agreements_landlord ON public.tenancy_agreements(landlord_id);
CREATE INDEX idx_tenancy_agreements_status ON public.tenancy_agreements(status);

CREATE INDEX idx_escrow_status ON public.escrow_transactions(status);
CREATE INDEX idx_escrow_reference ON public.escrow_transactions(paystack_reference);

CREATE INDEX idx_ratings_rated ON public.ratings_reviews(rated_id);
CREATE INDEX idx_ratings_score ON public.ratings_reviews(rating);

-- =====================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- =====================================================

-- Enable RLS on all tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenancy_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ratings_reviews ENABLE ROW LEVEL SECURITY;

-- Profiles: Users can read any profile, update their own
CREATE POLICY "Users can view all profiles" ON public.profiles
  FOR SELECT USING (true);

CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);

-- Listings: Students see available/verified, landlords see own
CREATE POLICY "Students see available verified listings" ON public.listings
  FOR SELECT USING (
    auth.uid() IN (SELECT id FROM public.profiles WHERE role = 'student')
    AND status = 'available'
    AND is_verified = TRUE
  );

CREATE POLICY "Landlords see own listings" ON public.listings
  FOR ALL USING (auth.uid() = landlord_id);

CREATE POLICY "Caretakers see managed listings" ON public.listings
  FOR SELECT USING (auth.uid() = caretaker_id);

-- Inspections: Students see own, landlords see on their properties
CREATE POLICY "Students see own inspections" ON public.inspections
  FOR SELECT USING (auth.uid() = student_id);

CREATE POLICY "Landlords see inspections on their listings" ON public.inspections
  FOR SELECT USING (
    auth.uid() IN (
      SELECT landlord_id FROM public.listings WHERE id = inspections.listing_id
    )
  );

-- =====================================================
-- TRIGGERS & FUNCTIONS
-- =====================================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_listings_updated_at
  BEFORE UPDATE ON public.listings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Auto-mark stale listings after 24 hours no response
CREATE OR REPLACE FUNCTION auto_mark_stale_listings()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.listings
  SET 
    status = 'unconfirmed',
    needs_confirmation = FALSE
  WHERE 
    last_confirmed_at < NOW() - INTERVAL '24 hours'
    AND status IN ('available', 'reserved')
    AND needs_confirmation = TRUE;
END;
$$;

-- Update listing status when reservation expires
CREATE OR REPLACE FUNCTION expire_reservations()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.reservations
  SET status = 'expired'
  WHERE status = 'active' AND reserved_until < NOW();
  
  UPDATE public.listings l
  SET status = 'available'
  FROM public.reservations r
  WHERE l.id = r.listing_id 
    AND r.status = 'expired'
    AND l.status = 'reserved';
END;
$$;

-- Update profile average rating when new review added
CREATE OR REPLACE FUNCTION update_profile_rating()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.profiles
  SET 
    average_rating = (
      SELECT AVG(rating)::DECIMAL(3,2)
      FROM public.ratings_reviews
      WHERE rated_id = NEW.rated_id
    ),
    total_ratings = (
      SELECT COUNT(*)
      FROM public.ratings_reviews
      WHERE rated_id = NEW.rated_id
    )
  WHERE id = NEW.rated_id;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_rating_after_review
  AFTER INSERT ON public.ratings_reviews
  FOR EACH ROW EXECUTE FUNCTION update_profile_rating();

-- =====================================================
-- INITIAL SEED DATA (For testing)
-- =====================================================

-- Create the areas table
CREATE TABLE IF NOT EXISTS public.areas (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    priority INTEGER,
    walk_time_range VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Insert sample areas
INSERT INTO public.areas (name, priority, walk_time_range) VALUES
('Onike', 1, '0-5 min walk'),
('Abule Oja', 1, '5-10 min walk'),
('Akoka', 1, '5-15 min walk'),
('Iwaya', 2, '10-15 min walk'),
('Bariga', 2, '15-25 min walk'),
('Sabo', 2, '10-20 min walk')
ON CONFLICT (name) DO NOTHING;

-- =====================================================
-- HELPER VIEWS
-- =====================================================

-- View for student dashboard
CREATE OR REPLACE VIEW student_dashboard_view AS
SELECT 
  p.id as student_id,
  p.full_name,
  COUNT(DISTINCT i.id) as total_inspections,
  COUNT(DISTINCT r.id) as total_reservations,
  COUNT(DISTINCT ta.id) as active_tenancies,
  COUNT(DISTINCT rt.id) as reviews_given,
  AVG(rt.rating) as average_rating_given
FROM public.profiles p
LEFT JOIN public.inspections i ON p.id = i.student_id
LEFT JOIN public.reservations r ON p.id = r.student_id AND r.status = 'converted_to_lease'
LEFT JOIN public.tenancy_agreements ta ON p.id = ta.student_id AND ta.status = 'active'
LEFT JOIN public.ratings_reviews rt ON p.id = rt.rater_id
WHERE p.role = 'student'
GROUP BY p.id, p.full_name;

-- View for landlord dashboard
CREATE OR REPLACE VIEW landlord_dashboard_view AS
SELECT 
  p.id as landlord_id,
  p.full_name,
  COUNT(DISTINCT l.id) as total_listings,
  COUNT(DISTINCT l.id) FILTER (WHERE l.is_verified = TRUE) as verified_listings,
  COUNT(DISTINCT i.id) as total_inspections,
  COUNT(DISTINCT ta.id) as active_tenancies,
  COALESCE(SUM(e.platform_fee_amount), 0) as total_platform_fees_earned,
  AVG(rt.rating) as average_rating
FROM public.profiles p
LEFT JOIN public.listings l ON p.id = l.landlord_id
LEFT JOIN public.inspections i ON l.id = i.listing_id
LEFT JOIN public.tenancy_agreements ta ON l.id = ta.listing_id AND ta.status = 'active'
LEFT JOIN public.escrow_transactions e ON ta.id = e.tenancy_agreement_id AND e.status = 'released_to_landlord'
LEFT JOIN public.ratings_reviews rt ON p.id = rt.rated_id
WHERE p.role = 'landlord'
GROUP BY p.id, p.full_name;