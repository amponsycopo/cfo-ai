// api/send-email.js
// Kirim laporan analisis manual dari tombol di dashboard

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { toEmail, toName, result, businessName } = req.body || {};
  if (!toEmail || !result) return res.status(400).json({ error: 'Missing toEmail or result' });

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return res.status(500).json({ error: 'Resend not configured' });

  try {
    const html = buildEmailHtml({ toName, result, businessName });

    const scoreEmoji = result.score >= 80 ? '🟢' : result.score >= 60 ? '🟡' : '🔴';
    const fraudAlerts = result.fraudAlerts || [];
    const hasFraud = fraudAlerts.length > 0;
    const subject = `${scoreEmoji} Laporan Findible — ${businessName || 'Bisnis Anda'} · Skor ${result.score}/100${hasFraud ? ` · 🚨 ${fraudAlerts.length} Anomali` : ''}`;

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Findible <laporan@findible.pro>',
        to: toEmail,
        subject,
        html
      })
    });

    if (!emailRes.ok) {
      const errText = await emailRes.text();
      console.error('Resend error:', errText);
      return res.status(500).json({ error: 'Failed to send email', detail: errText });
    }

    return res.status(200).json({ ok: true, to: toEmail });

  } catch (err) {
    console.error('send-email error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── Build HTML ──────────────────────────────────────────────────────────────
function buildEmailHtml({ toName, result, businessName }) {
  const name = toName || businessName || 'Sobat Bisnis';
  const biz  = businessName || 'Bisnis Anda';
  const score = result.score ?? 0;
  const scoreColor = score >= 80 ? '#16A34A' : score >= 60 ? '#D97706' : '#DC2626';
  const scoreLabel = score >= 80 ? 'Sehat' : score >= 60 ? 'Perlu Perhatian' : 'Kritis';
  const scoreEmoji = score >= 80 ? '🟢' : score >= 60 ? '🟡' : '🔴';

  const formatRp = (num) => {
    if (num == null || isNaN(num)) return 'N/A';
    const abs = Math.abs(num);
    const prefix = num < 0 ? '-' : '';
    if (abs >= 1e12) return `${prefix}Rp ${(abs/1e12).toFixed(1)} T`;
    if (abs >= 1e9)  return `${prefix}Rp ${(abs/1e9).toFixed(1)} M`;
    if (abs >= 1e6)  return `${prefix}Rp ${(abs/1e6).toFixed(1)} Jt`;
    return `${prefix}Rp ${abs.toLocaleString('id-ID')}`;
  };

  // KPIs
  const revenue = result.totalRevenue ?? result.revenue ?? null;
  const profit  = result.totalProfit  ?? result.profit  ?? null;
  const margin  = result.profitMargin ?? (revenue && profit != null ? (profit/revenue*100) : null);
  const marginColor = margin != null ? (margin >= 15 ? '#16A34A' : margin >= 5 ? '#D97706' : '#DC2626') : '#6B7280';

  // Fraud alerts
  const fraudAlerts = result.fraudAlerts || [];
  const hasFraud = fraudAlerts.length > 0;

  // Top 3 recs
  const recs = result.recommendations || [];
  const topRecs = recs
    .filter(r => ['critical','high'].includes((r.priority||'').toLowerCase()))
    .slice(0, 3);

  // Insights
  const insights = result.insights || result.keyInsights || [];

  // Fraud section
  const fraudSection = hasFraud ? `
    <div style="margin-bottom:24px;padding:16px;background:#FEF2F2;border-radius:12px;border-left:4px solid #DC2626;">
      <div style="font-weight:700;color:#DC2626;margin-bottom:10px;">🚨 ${fraudAlerts.length} Anomali Terdeteksi</div>
      ${fraudAlerts.slice(0,3).map(f => `
        <div style="margin-bottom:8px;padding:10px;background:white;border-radius:8px;border:1px solid #FECACA;">
          <div style="font-weight:600;color:#991B1B;font-size:13px;">⚠️ ${f.type || f.title || 'Anomali'}</div>
          <div style="color:#374151;font-size:12px;margin-top:2px;">${f.desc || f.description || ''}</div>
          ${f.action ? `<div style="color:#6B7280;font-size:11px;margin-top:4px;">→ ${f.action}</div>` : ''}
        </div>
      `).join('')}
    </div>` : '';

  // Top recs section
  const recsSection = topRecs.length > 0 ? `
    <div style="margin-bottom:24px;">
      <div style="font-weight:700;color:#111827;margin-bottom:10px;">🎯 Aksi Prioritas</div>
      ${topRecs.map((r, i) => {
        const medal = ['🥇','🥈','🥉'][i];
        const color = i === 0 ? '#DC2626' : i === 1 ? '#D97706' : '#CA8A04';
        return `<div style="margin-bottom:8px;padding:10px 12px;background:#F9FAFB;border-radius:8px;border-left:3px solid ${color};">
          <div style="font-weight:600;color:#111827;font-size:13px;">${medal} ${r.title || r.action || ''}</div>
          ${r.impact ? `<div style="color:#6B7280;font-size:11px;margin-top:2px;">💰 Dampak: ${formatRp(r.impactValue)} · ${r.impact}</div>` : ''}
        </div>`;
      }).join('')}
    </div>` : '';

  // Insights section
  const insightsSection = insights.length > 0 ? `
    <div style="margin-bottom:24px;">
      <div style="font-weight:700;color:#111827;margin-bottom:10px;">💡 Key Insights</div>
      ${insights.slice(0,4).map(ins => `
        <div style="margin-bottom:6px;padding:8px 12px;background:#EFF6FF;border-radius:8px;font-size:13px;color:#1E40AF;">
          ${typeof ins === 'string' ? ins : ins.text || ins.insight || JSON.stringify(ins)}
        </div>`).join('')}
    </div>` : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F4F6FB;font-family:'Segoe UI',Arial,sans-serif;">
<div style="max-width:560px;margin:24px auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

  <!-- HEADER -->
  <div style="background:linear-gradient(135deg,#1B3FE4 0%,#6366F1 100%);padding:28px 32px;">
    <div style="font-size:22px;font-weight:800;color:white;letter-spacing:-0.5px;">Findible</div>
    <div style="color:rgba(255,255,255,0.75);font-size:13px;margin-top:2px;">AI Mini CFO · Laporan Manual</div>
  </div>

  <!-- BODY -->
  <div style="padding:28px 32px;">
    <p style="margin:0 0 20px;color:#374151;font-size:15px;">Halo <strong>${name}</strong> 👋<br>Berikut ringkasan analisis keuangan terbaru <strong>${biz}</strong>:</p>

    <!-- SCORE -->
    <div style="text-align:center;padding:20px;background:#F9FAFB;border-radius:12px;margin-bottom:24px;">
      <div style="font-size:48px;font-weight:800;color:${scoreColor};line-height:1;">${scoreEmoji} ${score}</div>
      <div style="font-size:13px;color:#6B7280;margin-top:4px;">Business Health Score · <strong style="color:${scoreColor};">${scoreLabel}</strong></div>
    </div>

    <!-- KPIs -->
    <div style="display:flex;gap:12px;margin-bottom:24px;">
      <div style="flex:1;padding:14px;background:#F0FDF4;border-radius:10px;text-align:center;">
        <div style="font-size:11px;color:#6B7280;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px;">Revenue</div>
        <div style="font-weight:700;color:#111827;font-size:15px;">${revenue != null ? formatRp(revenue) : '—'}</div>
      </div>
      <div style="flex:1;padding:14px;background:#EFF6FF;border-radius:10px;text-align:center;">
        <div style="font-size:11px;color:#6B7280;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px;">Profit</div>
        <div style="font-weight:700;color:${profit != null && profit < 0 ? '#DC2626' : '#111827'};font-size:15px;">${profit != null ? formatRp(profit) : '—'}</div>
      </div>
      <div style="flex:1;padding:14px;background:#FFF7ED;border-radius:10px;text-align:center;">
        <div style="font-size:11px;color:#6B7280;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px;">Margin</div>
        <div style="font-weight:700;color:${marginColor};font-size:15px;">${margin != null ? margin.toFixed(1)+'%' : '—'}</div>
      </div>
    </div>

    ${fraudSection}
    ${recsSection}
    ${insightsSection}

    <!-- CTA -->
    <div style="text-align:center;padding-top:8px;">
      <a href="https://findible.pro/dashboard.html" style="display:inline-block;padding:13px 32px;background:#1B3FE4;color:white;border-radius:10px;font-weight:700;font-size:14px;text-decoration:none;">Buka Dashboard Lengkap →</a>
    </div>
  </div>

  <!-- FOOTER -->
  <div style="padding:14px 32px;background:#F4F6FB;font-size:11px;color:#9CA3AF;text-align:center;border-top:1px solid #E5E7EB;">
    Dikirim via Findible · <a href="https://findible.pro" style="color:#9CA3AF;text-decoration:none;">findible.pro</a>
  </div>

</div>
</body></html>`;
}
