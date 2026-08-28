-- ============================================
-- SESSION 2 suite : Historique corrections + CA juillet
-- ============================================

-- 1. Table historique des corrections
create table if not exists adjustments_history (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references employees(id) not null,
  period_date date not null,
  old_hours numeric,           -- valeur avant correction (null si nouvelle entrée)
  new_hours numeric not null,  -- nouvelle valeur
  note text,                   -- motif de la correction
  corrected_by text default 'admin',
  corrected_at timestamptz default now()
);
alter table adjustments_history enable row level security;
create policy "Allow all on adjustments_history" on adjustments_history
  for all using (true) with check (true);

-- 2. CA journalier juillet 2026 (à remplir avec les vraies valeurs)
-- Décommente et adapte les montants ci-dessous
-- insert into accounting_revenue (entry_date, amount) values
-- ('2026-07-01', 0),
-- ('2026-07-02', 0),
-- ...
-- Si tu as déjà des CA en base, cette requête affiche ce qui manque :
select 
  d.jour,
  coalesce(r.amount, 0) as ca
from (
  select generate_series('2026-07-01'::date, '2026-07-31'::date, '1 day')::date as jour
) d
left join accounting_revenue r on r.entry_date = d.jour
order by d.jour;
