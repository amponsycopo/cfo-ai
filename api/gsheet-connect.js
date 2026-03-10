// api/gsheet-connect.js — Tukar auth code jadi refresh token
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 30;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { code, userId, userToken } = req.body;
    if (!code || !userId) return res.status(400).json({ error: 'code dan userId required' });

    // Verify user via Supabase token
    const { data: { user }, error: authErr } = await supabase.auth.getUser(userToken);
    if (authErr || !user || user.id !== userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Tukar authorization code → access token + refresh token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: 'postmessage', // Untuk popup/ux_mode popup
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.json();
      console.error('Token exchange error:', err);
      throw new Error(err.error_description || 'Gagal tukar token');
    }

    const tokens = await tokenRes.json();
    console.log('Token exchange OK — has refresh_token:', !!tokens.refresh_token);

    // Simpan refresh token ke Supabase
    if (tokens.refresh_token) {
      await supabase.from('profiles').update({
        gsheet_refresh_token: tokens.refresh_token,
        gsheet_connected_at: new Date().toISOString()
      }).eq('id', userId);
    }

    return res.status(200).json({
      accessToken: tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token
    });

  } catch (err) {
    console.error('gsheet-connect error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
