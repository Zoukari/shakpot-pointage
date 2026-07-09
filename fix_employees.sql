-- ============================================
-- CORRECTIF : colonnes manquantes dans employees
-- à coller dans Supabase SQL Editor
-- ============================================
alter table employees add column if not exists hourly_rate numeric default null;
alter table employees add column if not exists comptabilite_access boolean default false;
alter table employees add column if not exists caissier_access boolean default false;
