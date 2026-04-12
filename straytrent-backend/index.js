const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// Import routes
const authRoutes = require('./routes/auth');
const listingRoutes = require('./routes/listings');
const inspectionRoutes = require('./routes/inspections');
const reservationRoutes = require('./routes/reservations');
const tenancyRoutes = require('./routes/tenancies');

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3001',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV
  });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/listings', listingRoutes);
app.use('/api/inspections', inspectionRoutes);
app.use('/api/reservations', reservationRoutes);
app.use('/api/tenancies', tenancyRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 StraytRent Backend running on port ${PORT}`);
  console.log(`📝 Environment: ${process.env.NODE_ENV}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
});

// Scheduled jobs (in production, use a proper job scheduler)
const cron = require('node-cron');

// Run every hour: expire stale reservations
cron.schedule('0 * * * *', async () => {
  console.log('Running: Expire stale reservations');
  const { supabaseAdmin } = require('./utils/supabase');
  
  try {
    // Expire reservations
    await supabaseAdmin.rpc('expire_reservations');
    
    // Mark stale listings
    await supabaseAdmin.rpc('auto_mark_stale_listings');
    
    console.log('Scheduled jobs completed');
  } catch (error) {
    console.error('Scheduled job error:', error);
  }
});

// Run daily at 9 AM: Send caretaker ping reminders
cron.schedule('0 9 * * *', async () => {
  console.log('Running: Send caretaker ping reminders');
  const { supabaseAdmin } = require('./utils/supabase');
  const { sendCaretakerPing } = require('./utils/termii');
  
  try {
    // Find listings that haven't been confirmed in 14 days
    const { data: staleListings, error } = await supabaseAdmin
      .from('listings')
      .select('id, title, caretaker:profiles!caretaker_id(phone_number)')
      .lt('last_confirmed_at', new Date(Date.now() - 14 * 24 * 60 * 60 * 1000))
      .eq('needs_confirmation', true)
      .not('caretaker_id', 'is', null);
    
    for (const listing of staleListings || []) {
      if (listing.caretaker?.phone_number) {
        await sendCaretakerPing(
          listing.caretaker.phone_number,
          listing.title,
          listing.id
        );
        
        // Log the ping
        await supabaseAdmin
          .from('availability_log')
          .insert({
            listing_id: listing.id,
            ping_sent_at: new Date().toISOString(),
            ping_channel: 'whatsapp'
          });
        
        // Mark as needing confirmation
        await supabaseAdmin
          .from('listings')
          .update({ needs_confirmation: true })
          .eq('id', listing.id);
      }
    }
    
    console.log(`Sent ${staleListings?.length || 0} caretaker pings`);
  } catch (error) {
    console.error('Caretaker ping error:', error);
  }
});

module.exports = app;