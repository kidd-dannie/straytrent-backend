const nodemailer = require('nodemailer');
const sgMail = require('@sendgrid/mail');
const { Resend } = require('resend');
require('dotenv').config();

// Choose email provider based on environment variables
const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || 'nodemailer'; // 'sendgrid', 'resend', or 'nodemailer'

let transporter;
let resendClient;

// Configure based on provider
if (EMAIL_PROVIDER === 'sendgrid') {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
} else if (EMAIL_PROVIDER === 'resend') {
  resendClient = new Resend(process.env.RESEND_API_KEY);
} else {
  // Default to nodemailer (works with Gmail)
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });
}

/**
 * Send OTP email
 */
async function sendOTPEmail(email, otp, purpose = 'login') {
  const subject = `StraytRent - Your ${purpose} OTP Code`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #4F46E5; color: white; padding: 20px; text-align: center; }
        .content { padding: 20px; background-color: #f9fafb; }
        .otp-code { font-size: 32px; font-weight: bold; text-align: center; padding: 20px; background-color: white; border-radius: 8px; margin: 20px 0; letter-spacing: 5px; }
        .footer { text-align: center; padding: 20px; font-size: 12px; color: #6b7280; }
        .button { display: inline-block; padding: 10px 20px; background-color: #4F46E5; color: white; text-decoration: none; border-radius: 5px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>StraytRent</h1>
        </div>
        <div class="content">
          <h2>Your Verification Code</h2>
          <p>Hello,</p>
          <p>You requested to ${purpose === 'login' ? 'log in to' : 'sign up for'} StraytRent. Use the verification code below to complete your ${purpose}.</p>
          <div class="otp-code">${otp}</div>
          <p>This code will expire in <strong>10 minutes</strong>.</p>
          <p>If you didn't request this, please ignore this email.</p>
          <br>
          <p>Best regards,<br>The StraytRent Team</p>
        </div>
        <div class="footer">
          <p>© 2026 StraytRent. All rights reserved.</p>
          <p>Making off-campus living easier for Nigerian students.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const text = `Your StraytRent ${purpose} OTP code is: ${otp}. Valid for 10 minutes.`;

  try {
    if (EMAIL_PROVIDER === 'sendgrid') {
      const msg = {
        to: email,
        from: process.env.SENDER_EMAIL,
        subject,
        text,
        html
      };
      await sgMail.send(msg);
    } else if (EMAIL_PROVIDER === 'resend') {
      await resendClient.emails.send({
        from: process.env.SENDER_EMAIL,
        to: email,
        subject,
        html
      });
    } else {
      // Nodemailer
      await transporter.sendMail({
        from: `"StraytRent" <${process.env.GMAIL_USER}>`,
        to: email,
        subject,
        text,
        html
      });
    }
    
    console.log(`OTP email sent to ${email}`);
    return true;
  } catch (error) {
    console.error('Email send error:', error);
    throw new Error('Failed to send OTP email');
  }
}

/**
 * Send welcome email after registration
 */
async function sendWelcomeEmail(email, fullName, role) {
  const subject = `Welcome to StraytRent, ${fullName}!`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #4F46E5; color: white; padding: 20px; text-align: center; }
        .content { padding: 20px; background-color: #f9fafb; }
        .feature { margin: 20px 0; padding: 15px; background-color: white; border-radius: 8px; }
        .footer { text-align: center; padding: 20px; font-size: 12px; color: #6b7280; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Welcome to StraytRent!</h1>
        </div>
        <div class="content">
          <h2>Hello ${fullName},</h2>
          <p>Thank you for joining StraytRent as a <strong>${role}</strong>!</p>
          
          <div class="feature">
            <h3>🎉 What you can do next:</h3>
            ${role === 'student' ? `
              <ul>
                <li>Browse verified listings near UNILAG</li>
                <li>Book inspections with trusted landlords</li>
                <li>Pay rent securely through our escrow system</li>
                <li>Build your rental history and reputation</li>
              </ul>
            ` : role === 'landlord' ? `
              <ul>
                <li>List your properties for free</li>
                <li>Receive verified student leads</li>
                <li>Get paid on time through escrow</li>
                <li>Build your verified landlord badge</li>
              </ul>
            ` : role === 'caretaker' ? `
              <ul>
                <li>Manage properties you oversee</li>
                <li>Earn commissions for successful leases</li>
                <li>Simple WhatsApp-based availability updates</li>
              </ul>
            ` : `
              <ul>
                <li>List properties on behalf of landlords</li>
                <li>Earn volume-based commissions</li>
                <li>Founding partners get permanent higher tier</li>
              </ul>
            `}
          </div>
          
          <p>Get started by completing your KYC verification to earn your verified badge!</p>
          
          <a href="${process.env.FRONTEND_URL}/dashboard" class="button" style="display: inline-block; padding: 12px 24px; background-color: #4F46E5; color: white; text-decoration: none; border-radius: 5px;">Go to Dashboard</a>
        </div>
        <div class="footer">
          <p>© 2026 StraytRent. Making off-campus living easier for Nigerian students.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    if (EMAIL_PROVIDER === 'sendgrid') {
      await sgMail.send({
        to: email,
        from: process.env.SENDER_EMAIL,
        subject,
        html
      });
    } else if (EMAIL_PROVIDER === 'resend') {
      await resendClient.emails.send({
        from: process.env.SENDER_EMAIL,
        to: email,
        subject,
        html
      });
    } else {
      await transporter.sendMail({
        from: `"StraytRent" <${process.env.GMAIL_USER}>`,
        to: email,
        subject,
        html
      });
    }
    return true;
  } catch (error) {
    console.error('Welcome email error:', error);
    return false; // Don't throw - welcome email is non-critical
  }
}

/**
 * Send caretaker availability ping via email
 */
async function sendCaretakerPingEmail(caretakerEmail, unitTitle, unitId) {
  const subject = `StraytRent: Is "${unitTitle}" still available?`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .button { display: inline-block; padding: 10px 20px; margin: 10px; background-color: #4F46E5; color: white; text-decoration: none; border-radius: 5px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>Unit Availability Check</h2>
        <p>Please confirm if "${unitTitle}" is still available for rent.</p>
        <div>
          <a href="${process.env.FRONTEND_URL}/api/listings/${unitId}/ping?response=yes" class="button">✓ Yes, still available</a>
          <a href="${process.env.FRONTEND_URL}/api/listings/${unitId}/ping?response=no" class="button" style="background-color: #ef4444;">✗ No, it's taken</a>
        </div>
        <p>If we don't hear from you within 24 hours, this unit will be marked as unconfirmed.</p>
        <hr>
        <p style="font-size: 12px; color: #666;">You can also reply to this email with "1" for Yes or "2" for No.</p>
      </div>
    </body>
    </html>
  `;

  try {
    if (EMAIL_PROVIDER === 'sendgrid') {
      await sgMail.send({ to: caretakerEmail, from: process.env.SENDER_EMAIL, subject, html });
    } else if (EMAIL_PROVIDER === 'resend') {
      await resendClient.emails.send({ from: process.env.SENDER_EMAIL, to: caretakerEmail, subject, html });
    } else {
      await transporter.sendMail({ from: `"StraytRent" <${process.env.GMAIL_USER}>`, to: caretakerEmail, subject, html });
    }
    return true;
  } catch (error) {
    console.error('Caretaker ping email error:', error);
    return false;
  }
}

/**
 * Send inspection reminder
 */
async function sendInspectionReminderEmail(studentEmail, unitTitle, dateTime, address) {
  const subject = `StraytRent Reminder: Inspection for "${unitTitle}"`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>🔔 Inspection Reminder</h2>
      <p>Your inspection for <strong>${unitTitle}</strong> is scheduled for:</p>
      <p><strong>${new Date(dateTime).toLocaleString()}</strong></p>
      <p><strong>📍 Location:</strong> ${address}</p>
      <p>Please arrive on time. If you need to cancel, please do so at least 2 hours before to avoid forfeiting your deposit.</p>
      <p>Need help? Contact us at support@straytrent.com</p>
    </div>
  `;

  try {
    if (EMAIL_PROVIDER === 'sendgrid') {
      await sgMail.send({ to: studentEmail, from: process.env.SENDER_EMAIL, subject, html });
    } else if (EMAIL_PROVIDER === 'resend') {
      await resendClient.emails.send({ from: process.env.SENDER_EMAIL, to: studentEmail, subject, html });
    } else {
      await transporter.sendMail({ from: `"StraytRent" <${process.env.GMAIL_USER}>`, to: studentEmail, subject, html });
    }
    return true;
  } catch (error) {
    console.error('Inspection reminder error:', error);
    return false;
  }
}

module.exports = {
  sendOTPEmail,
  sendWelcomeEmail,
  sendCaretakerPingEmail,
  sendInspectionReminderEmail
};