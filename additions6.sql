-- ============================================
-- AJOUT : dette livreur + argent du mois
-- à coller dans Supabase SQL Editor
-- ============================================

-- Table des dettes livreur (ce que tu lui donnes vs ce qu'il paie)
create table if not exists accounting_delivery_debts (
  id uuid primary key default gen_random_uuid(),
  entry_date date not null,
  amount_given numeric not null default 0,   -- ce que tu lui as donné
  amount_paid numeric not null default 0,    -- ce qu'il a payé
  note text,
  entered_by uuid references employees(id),
  created_at timestamptz default now()
);
alter table accounting_delivery_debts enable row level security;
create policy "Allow all on accounting_delivery_debts" on accounting_delivery_debts
  for all using (true) with check (true);
create index idx_debts_date on accounting_delivery_debts(entry_date);

-- Table de l'argent du mois (solde de départ, auto-calculé ou saisi manuellement)
create table if not exists accounting_month_balance (
  id uuid primary key default gen_random_uuid(),
  month_date date not null unique,  -- 1er du mois concerné
  auto_amount numeric,              -- bénéfice net du mois précédent (calculé)
  manual_override numeric,          -- saisie manuelle si besoin (remplace auto)
  created_at timestamptz default now()
);
alter table accounting_month_balance enable row level security;
create policy "Allow all on accounting_month_balance" on accounting_month_balance
  for all using (true) with check (true);

-- Colonne pour marquer qu'un code d'activation a été utilisé
alter table app_settings add column if not exists kiosk_code_used boolean default false;
