-- ============================================
-- SESSION 2 : Repos compensatoires
-- ============================================

create table if not exists compensatory_days (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references employees(id) not null,
  -- Acquisition
  acquired_date date not null,          -- date du repos travaillé
  acquired_hours numeric not null,      -- heures travaillées ce jour
  acquired_note text,                   -- motif
  -- Utilisation
  used_date date,                       -- date où le repos a été pris
  used_note text,
  -- Statut
  status text default 'available' check (status in ('available', 'used', 'cancelled')),
  -- Audit
  created_by text default 'admin',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table compensatory_days enable row level security;
create policy "Allow all on compensatory_days" on compensatory_days
  for all using (true) with check (true);

-- Créditer Saida : 1 jour (repos travaillé le 13 juillet, 7h48)
insert into compensatory_days (employee_id, acquired_date, acquired_hours, acquired_note, status)
select id, '2026-07-13', 7.8, 'Repos travaillé le 13/07/2026 — 7h48 non payées en juillet', 'available'
from employees where full_name = 'Saida';
