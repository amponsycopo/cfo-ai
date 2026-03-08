-- =============================================
-- CFO.ai — Supabase Setup Script
-- Jalankan di: Supabase Dashboard → SQL Editor
-- =============================================

-- 1. Tabel profiles (user + credits)
create table if not exists profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null,
  business_name text,
  credits       integer default 3,
  created_at    timestamptz default now()
);

-- 2. Row Level Security — user hanya bisa lihat data sendiri
alter table profiles enable row level security;

create policy "Users can view own profile"
  on profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on profiles for update
  using (auth.uid() = id);

create policy "Users can insert own profile"
  on profiles for insert
  with check (auth.uid() = id);

-- 3. Service role bisa update credits (untuk Vercel backend)
-- (Tidak perlu policy tambahan — service key bypass RLS)

-- =============================================
-- SELESAI — lanjut ke langkah berikutnya
-- =============================================
