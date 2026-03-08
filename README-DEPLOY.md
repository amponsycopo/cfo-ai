# 🚀 CFO.ai MVP — Panduan Deploy
> Estimasi waktu: 25-30 menit

---

## STEP 1 — Buat akun Supabase (5 menit)

1. Buka **https://supabase.com** → Sign Up (gratis)
2. Buat project baru:
   - Name: `cfo-ai`
   - Database Password: buat yang kuat, simpan di notes
   - Region: **Southeast Asia (Singapore)**
3. Tunggu project ready (~2 menit)
4. Pergi ke **Settings → API**, catat:
   - `Project URL` → ini `SUPABASE_URL`
   - `anon public` key → ini `SUPABASE_KEY`
   - `service_role` key → ini `SUPABASE_SERVICE_KEY` ⚠️ jangan expose ke publik

5. Pergi ke **SQL Editor** → klik **New Query** → paste isi file `supabase-setup.sql` → klik **Run**

---

## STEP 2 — Buat akun Resend (3 menit)

1. Buka **https://resend.com** → Sign Up (gratis, 3.000 email/bulan)
2. Pergi ke **API Keys** → Create API Key
   - Name: `cfo-ai-prod`
   - Permission: Sending access
3. Catat API key → ini `RESEND_API_KEY`
4. (Opsional tapi recommended) Pergi ke **Domains** → tambah domain lo
   - Kalau belum punya domain, pakai `onboarding@resend.dev` dulu untuk testing

---

## STEP 3 — Deploy ke Vercel (10 menit)

1. Buka **https://vercel.com** → Sign Up dengan GitHub
2. Install Vercel CLI (atau pakai dashboard):
   ```
   npm install -g vercel
   ```
3. Di terminal, masuk ke folder project:
   ```
   cd cfo-mvp
   vercel
   ```
   - Set up project? **Y**
   - Which scope? pilih akun lo
   - Link to existing? **N**
   - Project name: `cfo-ai`
   - Directory: `.`
   - Override settings? **N**

4. Setelah deploy, pergi ke **Vercel Dashboard → Project → Settings → Environment Variables**
   Tambahkan semua ini:

   | Key | Value |
   |-----|-------|
   | `SUPABASE_URL` | URL dari Step 1 |
   | `SUPABASE_SERVICE_KEY` | service_role key dari Step 1 |
   | `GROQ_API_KEY` | API key Groq lo |
   | `RESEND_API_KEY` | API key dari Step 2 |

5. Setelah tambah env vars, redeploy:
   ```
   vercel --prod
   ```
6. Catat URL Vercel lo → contoh: `https://cfo-ai-erlando.vercel.app`

---

## STEP 4 — Update config di file HTML (5 menit)

Buka **`index.html`** dan **`app.html`**, cari dan ganti:

```javascript
// index.html — ganti 2 baris ini:
const SUPABASE_URL = 'GANTI_SUPABASE_URL';
const SUPABASE_KEY = 'GANTI_SUPABASE_ANON_KEY';

// app.html — ganti 3 baris ini:
const SUPABASE_URL = 'GANTI_SUPABASE_URL';
const SUPABASE_KEY = 'GANTI_SUPABASE_ANON_KEY';
const API_BASE     = 'GANTI_VERCEL_URL';
```

Juga di `app.html`, cari `NOMOR_WA_LO` dan ganti dengan nomor WA lo (format: `6281234567890`).

---

## STEP 5 — Upload file ke Vercel (2 menit)

Setelah update config, redeploy:
```
vercel --prod
```

Atau drag & drop folder ke Vercel dashboard.

---

## STEP 6 — Test (5 menit)

1. Buka URL Vercel lo → harusnya muncul halaman login
2. Klik **Daftar** → buat akun dengan email lo sendiri
3. Upload `demo_data_cfo_ai_fraud.xlsx`
4. Pastikan:
   - ✅ Analisis berjalan
   - ✅ Badge "3 analisis tersisa" muncul di atas
   - ✅ Email laporan masuk
   - ✅ Setelah 3x analisis, muncul overlay "Kredit Habis"

---

## Cara buat akun demo untuk calon klien

Di Supabase Dashboard → **Authentication → Users** → **Invite User**

Atau bisa juga share URL dan minta mereka daftar sendiri — kredit 3 otomatis.

---

## Struktur file

```
cfo-mvp/
├── index.html          ← Halaman login/register
├── app.html            ← App utama (modif dari cfo-ai-groq.html)
├── vercel.json         ← Config Vercel
├── supabase-setup.sql  ← SQL untuk Supabase
└── api/
    ├── analyze.js      ← Backend: Groq AI (API key tersembunyi)
    └── send-email.js   ← Backend: Kirim email via Resend
```

---

## Troubleshooting

**Login gagal / CORS error**
→ Cek Supabase URL dan anon key sudah benar di HTML

**Analisis gagal "Server error"**
→ Cek Vercel → Functions → Logs untuk error detail
→ Pastikan env vars sudah di-set dan redeploy

**Email tidak terkirim**
→ Cek Resend dashboard → Logs
→ Kalau pakai domain sendiri, pastikan DNS sudah verify

**Credits tidak berkurang**
→ Cek Supabase → Table Editor → profiles → lihat row user
→ Pastikan `SUPABASE_SERVICE_KEY` (bukan anon key) yang dipakai di Vercel env

---

Selamat deploy! 🎉
