// api/send-email.js — Vercel Serverless Function
// Sends HTML email via Resend — no EmailJS needed

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { toEmail, toName, result, businessName } = req.body;
    if (!toEmail || !result) return res.status(400).json({ error: 'Missing required fields' });

    const html = buildEmailHtml(result, toName || toEmail, businessName);
    const date = new Date().toLocaleDateString('id-ID', { day:'numeric', month:'long', year:'numeric' });

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: 'CFO.ai <onboarding@resend.dev>',  // ganti dengan domain lo yang sudah verify di Resend
        to: [toEmail],
        subject: `Laporan Keuangan CFO.ai — ${date}`,
        html
      })
    });

    if (!resendRes.ok) {
      const err = await resendRes.json();
      throw new Error(err.message || 'Resend error');
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Email error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function formatRp(num) {
  const abs = Math.abs(num);
  if (abs >= 1000000000) return 'Rp ' + (abs/1000000000).toFixed(1) + 'M';
  if (abs >= 1000000)    return 'Rp ' + (abs/1000000).toFixed(1) + ' jt';
  if (abs >= 1000)       return 'Rp ' + (abs/1000).toFixed(0) + 'rb';
  return 'Rp ' + abs.toFixed(0);
}

function buildEmailHtml(r, toName, businessName) {
  const date = new Date().toLocaleDateString('id-ID', {day:'numeric',month:'long',year:'numeric'});
  const scoreColor  = r.score >= 75 ? '#4CAF82' : r.score >= 55 ? '#D4A843' : '#E57373';
  const profitColor = r.profit >= 0 ? '#4CAF82' : '#E57373';
  const fraudAlerts = r.fraudAlerts || [];
  const hasFraud    = fraudAlerts.length > 0;

  const insightsHtml = (r.insights || []).map(i => {
    const bg     = i.type==='ok' ? '#0D2A1A' : i.type==='warn' ? '#2A1F0A' : '#1A1F0A';
    const border = i.type==='ok' ? '#1B4D3E' : i.type==='warn' ? '#4D3A0A' : '#2D3A0A';
    const color  = i.type==='ok' ? '#4CAF82' : i.type==='warn' ? '#D4A843' : '#A8C55A';
    return `
      <div style="background:${bg};border:1px solid ${border};border-radius:10px;padding:14px 16px;margin-bottom:10px;">
        <div style="font-size:13px;font-weight:700;color:${color};margin-bottom:6px;">${i.icon || ''} ${i.title || ''}</div>
        <div style="font-size:13px;color:#C8C8C0;line-height:1.6;">${i.text}</div>
        ${i.reason ? `<div style="margin-top:8px;font-size:12px;color:#8A8A84;background:#0D0D0B;border-radius:6px;padding:8px 12px;line-height:1.5;">💼 <strong style="color:#A8A8A0;">Analisis CFO:</strong> ${i.reason}</div>` : ''}
      </div>`;
  }).join('');

  const recsHtml = (r.recs || []).map(rec => {
    const pColor = rec.priority==='high' ? '#E57373' : rec.priority==='med' ? '#D4A843' : '#4CAF82';
    const pLabel = rec.priority==='high' ? '🔴 Prioritas Tinggi' : rec.priority==='med' ? '🟡 Prioritas Sedang' : '🟢 Quick Win';
    return `
      <div style="background:#111210;border:1px solid #2A2A24;border-radius:10px;padding:14px 16px;margin-bottom:10px;">
        <div style="font-size:10px;font-weight:700;color:${pColor};letter-spacing:0.5px;margin-bottom:5px;">${pLabel}</div>
        <div style="font-size:14px;font-weight:700;color:#E8E8E0;margin-bottom:5px;">${rec.title}</div>
        <div style="font-size:13px;color:#A0A09A;line-height:1.6;">${rec.desc}</div>
        ${rec.impact ? `<div style="margin-top:8px;font-size:12px;color:#4CAF82;font-weight:600;">📈 ${rec.impact}</div>` : ''}
      </div>`;
  }).join('');

  const fraudHtml = hasFraud
    ? `<div style="background:#1A0808;border:1px solid #3A1515;border-radius:12px;overflow:hidden;margin-top:8px;">
        <div style="background:#2D1010;padding:14px 20px;">
          <span style="font-size:14px;font-weight:700;color:#E57373;">🚨 Fraud Radar — ${fraudAlerts.length} Anomali Terdeteksi</span>
        </div>
        <div style="padding:14px 20px;">
          ${fraudAlerts.map(a => {
            const isCrit = a.severity === 'critical';
            const fc = isCrit ? '#EF5350' : '#FFB74D';
            const bc = isCrit ? '#3A1515' : '#3A2E0A';
            return `<div style="border:1px solid ${bc};border-radius:8px;padding:12px 14px;margin-bottom:10px;background:#0D0808;">
              <div style="font-size:11px;font-weight:700;color:${fc};margin-bottom:4px;">${a.type}${a.date?' · '+a.date:''}${a.amount?' · Rp '+Number(a.amount).toLocaleString('id'):''}</div>
              <div style="font-size:13px;color:#C0B0B0;margin-bottom:6px;">${a.desc}</div>
              <div style="font-size:12px;color:#8A8080;background:#1A0D0D;border-radius:5px;padding:7px 10px;">💡 ${a.action}</div>
            </div>`;
          }).join('')}
        </div>
      </div>`
    : `<div style="background:#0D2A1A;border:1px solid #1B4D3E;border-radius:10px;padding:14px 16px;">
        <div style="font-size:13px;color:#4CAF82;">✅ Tidak ada anomali terdeteksi — data keuangan bersih.</div>
      </div>`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0A0A08;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A08;padding:32px 16px;">
<tr><td align="center">
<table width="100%" style="max-width:600px;" cellpadding="0" cellspacing="0">

  <tr><td style="background:#0D2A1A;border-radius:16px 16px 0 0;padding:32px;border:1px solid #1B4D3E;border-bottom:none;">
    <div style="font-size:11px;font-weight:700;color:#4CAF82;letter-spacing:2px;margin-bottom:8px;">CFO.AI</div>
    <div style="font-size:24px;font-weight:700;color:#F0F0E8;margin-bottom:4px;">Laporan Keuangan AI</div>
    <div style="font-size:13px;color:#6A9A7A;">${businessName ? businessName + ' · ' : ''}${date}</div>
  </td></tr>

  <tr><td style="background:#0D1A10;border:1px solid #1B4D3E;border-top:none;border-bottom:none;padding:0 32px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="25%" style="padding:20px 10px 20px 0;border-right:1px solid #1A2A1A;">
        <div style="font-size:9px;color:#4A7A5A;font-weight:700;letter-spacing:1px;margin-bottom:5px;">PENDAPATAN</div>
        <div style="font-size:17px;font-weight:700;color:#4CAF82;">${formatRp(r.totalIncome)}</div>
      </td>
      <td width="25%" style="padding:20px 10px;border-right:1px solid #1A2A1A;">
        <div style="font-size:9px;color:#4A7A5A;font-weight:700;letter-spacing:1px;margin-bottom:5px;">PENGELUARAN</div>
        <div style="font-size:17px;font-weight:700;color:#E57373;">${formatRp(r.totalExpense)}</div>
      </td>
      <td width="25%" style="padding:20px 10px;border-right:1px solid #1A2A1A;">
        <div style="font-size:9px;color:#4A7A5A;font-weight:700;letter-spacing:1px;margin-bottom:5px;">LABA BERSIH</div>
        <div style="font-size:17px;font-weight:700;color:${profitColor};">${formatRp(r.profit)}</div>
        <div style="font-size:11px;color:#6A8A6A;margin-top:2px;">Margin ${r.margin}%</div>
      </td>
      <td width="25%" style="padding:20px 0 20px 10px;">
        <div style="font-size:9px;color:#4A7A5A;font-weight:700;letter-spacing:1px;margin-bottom:5px;">SKOR KESEHATAN</div>
        <div style="font-size:17px;font-weight:700;color:${scoreColor};">${r.score}/100</div>
        <div style="font-size:11px;color:#6A8A6A;margin-top:2px;">${r.scoreLabel}</div>
      </td>
    </tr></table>
  </td></tr>

  ${hasFraud ? `<tr><td style="background:#1A0808;border:1px solid #3A1515;border-top:2px solid #E57373;padding:12px 32px;">
    <span style="font-size:13px;font-weight:700;color:#E57373;">🚨 ${fraudAlerts.length} anomali keuangan terdeteksi — lihat detail di bawah</span>
  </td></tr>` : ''}

  <tr><td style="background:#0F0F0D;border:1px solid #1E1E18;border-top:none;border-radius:0 0 16px 16px;padding:28px 32px;">

    <div style="font-size:10px;font-weight:700;color:#3A3A34;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #1E1E18;">🤖 AI Insights</div>
    ${insightsHtml}

    <div style="font-size:10px;font-weight:700;color:#3A3A34;letter-spacing:1.5px;text-transform:uppercase;margin:24px 0 14px;padding-bottom:10px;border-bottom:1px solid #1E1E18;">💡 Rekomendasi CFO</div>
    ${recsHtml}

    <div style="font-size:10px;font-weight:700;color:#3A3A34;letter-spacing:1.5px;text-transform:uppercase;margin:24px 0 14px;padding-bottom:10px;border-bottom:1px solid #1E1E18;">🚨 Fraud Radar</div>
    ${fraudHtml}

    <div style="margin-top:32px;padding-top:20px;border-top:1px solid #1E1E18;font-size:11px;color:#2A2A24;text-align:center;line-height:1.6;">
      Laporan dihasilkan otomatis oleh <strong style="color:#4CAF82;">CFO.ai</strong><br>
      Bersifat indikatif — verifikasi dengan akuntan untuk keputusan bisnis penting.
    </div>

  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}
