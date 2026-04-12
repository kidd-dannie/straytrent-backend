const axios = require('axios');
require('dotenv').config();

const TERMII_API_KEY = process.env.TERMII_API_KEY;
const TERMII_BASE_URL = 'https://api.termii.com/api';

/**
 * Send WhatsApp message via Termii
 */
async function sendWhatsAppMessage(phoneNumber, message) {
  try {
    const response = await axios.post(`${TERMII_BASE_URL}/whatsapp/send`, {
      to: phoneNumber,
      from: process.env.TERMII_SENDER_ID,
      sms: message,
      type: 'text',
      api_key: TERMII_API_KEY
    });
    return response.data;
  } catch (error) {
    console.error('Termii WhatsApp error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Send SMS via Termii
 */
async function sendSMS(phoneNumber, message) {
  try {
    const response = await axios.post(`${TERMII_BASE_URL}/sms/send`, {
      to: phoneNumber,
      from: process.env.TERMII_SENDER_ID,
      sms: message,
      type: 'plain',
      api_key: TERMII_API_KEY,
      channel: 'generic'
    });
    return response.data;
  } catch (error) {
    console.error('Termii SMS error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Send OTP via Termii (WhatsApp or SMS)
 */
async function sendOTP(phoneNumber, code, channel = 'whatsapp') {
  const message = `Your StraytRent verification code is: ${code}. Valid for 10 minutes.`;
  
  if (channel === 'whatsapp') {
    return sendWhatsAppMessage(phoneNumber, message);
  } else {
    return sendSMS(phoneNumber, message);
  }
}

/**
 * Send caretaker availability ping
 */
async function sendCaretakerPing(caretakerPhone, unitTitle, unitId) {
  const message = `🏠 StraytRent: Is "${unitTitle}" still available?\n\nReply: 1 for Yes\nReply: 2 for No\nReply: 3 for Someone just moved in\n\nIf we don't hear from you in 24h, this unit will be marked unconfirmed.`;
  
  return sendWhatsAppMessage(caretakerPhone, message);
}

/**
 * Send inspection reminder
 */
async function sendInspectionReminder(studentPhone, unitTitle, dateTime, address) {
  const message = `🔔 StraytRent Reminder: Your inspection for "${unitTitle}" is scheduled for ${new Date(dateTime).toLocaleString()}.\n\n📍 Address: ${address}\n\nPlease arrive on time. If you need to cancel, please do so at least 2 hours before to avoid forfeiting your deposit.`;
  
  return sendWhatsAppMessage(studentPhone, message);
}

module.exports = {
  sendWhatsAppMessage,
  sendSMS,
  sendOTP,
  sendCaretakerPing,
  sendInspectionReminder
};