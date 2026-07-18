-- ============================================
-- AJOUT : annexes livreur (avances, remboursements, etc.)
-- à coller dans Supabase SQL Editor
-- ============================================
create table if not exists accounting_delivery_annex (
  id uuid primary key default gen_random_uuid(),
  entry_date date not null,
  amount numeric not null,
  motif text,
  entered_by uuid references employees(id),
  created_at timestamptz default now()
);
alter table accounting_delivery_annex enable row level security;
create policy "Allow all on accounting_delivery_annex" on accounting_delivery_annex
  for all using (true) with check (true);
create index idx_annex_date on accounting_delivery_annex(entry_date);

-- Ajouter la contrainte unique sur entry_date pour le upsert
alter table accounting_delivery_debts add constraint if not exists uniq_debt_date unique (entry_date);
