-- ============================================
-- CORRECTIONS JUILLET 2026
-- Saida, Salma, Habsa, Fatouma
-- À exécuter dans Supabase SQL Editor
-- ============================================

-- 1. Mettre à jour les taux horaires
update employees set hourly_rate = 249 where full_name ilike '%saida%';
update employees set hourly_rate = 204 where full_name ilike '%salma%';
update employees set hourly_rate = 181 where full_name ilike '%habsa%' or full_name ilike '%hasna%';
update employees set hourly_rate = 107 where full_name ilike '%fatouma%' or full_name ilike '%neima%';

-- 2. Supprimer les anciennes corrections de juillet pour repartir propre
delete from hours_adjustments
where period_type = 'day'
  and period_date >= '2026-07-01'
  and period_date <= '2026-07-31';

-- 3. Récupérer les IDs employés (à adapter si les noms sont différents)
-- Vérifier avec : select id, full_name from employees;

-- 4. SAIDA — corrections juillet
-- Journée corrigée à 15h00 (au lieu de 10h00 théoriques → +5h00)
-- On utilise une sous-requête pour récupérer l'ID
insert into hours_adjustments (employee_id, period_type, period_date, total_hours, note)
select id, 'day', '2026-07-26', 15.0, 'Correction admin : 15h00 travaillées (planning 10h00, +5h00)'
from employees where full_name ilike '%saida%';

-- Jour de repos travaillé (7h48) → repos compensatoire (non comptabilisé en juillet)
-- On ne crée PAS d'ajustement pour ce jour car il n'est pas payé en juillet

-- 5. SALMA — corrections juillet
-- Journée corrigée à 15h00
insert into hours_adjustments (employee_id, period_type, period_date, total_hours, note)
select id, 'day', '2026-07-26', 15.0, 'Correction admin : 15h00 travaillées (planning 10h00, +5h00)'
from employees where full_name ilike '%salma%';

-- 6. HABSA — date de début le 8 juillet
-- Heures théoriques calculées depuis le 8 juillet
-- La journée du 8 juillet = 8h30
insert into hours_adjustments (employee_id, period_type, period_date, total_hours, note)
select id, 'day', '2026-07-08', 8.5, 'Premier jour de travail — 8h30'
from employees where full_name ilike '%habsa%' or full_name ilike '%hasna%';

-- Absence du 23 juillet = 0h
insert into hours_adjustments (employee_id, period_type, period_date, total_hours, note)
select id, 'day', '2026-07-23', 0, 'Absence'
from employees where full_name ilike '%habsa%' or full_name ilike '%hasna%';

-- Repos travaillé 15 juillet = 7h22 (intégré dans le total)
insert into hours_adjustments (employee_id, period_type, period_date, total_hours, note)
select id, 'day', '2026-07-15', 7.3667, 'Repos travaillé : 7h22'
from employees where full_name ilike '%habsa%' or full_name ilike '%hasna%';

-- 7. FATOUMA — calcul depuis le 16 juillet, total corrigé = 124h00
-- On corrige le total global avec un ajustement mensuel
-- On va créer des ajustements pour les jours 1-15 juillet = 0h chacun
-- Plus simple : on crée un ajustement pour chaque jour 01-15 à 0h
do $$
declare
  emp_id uuid;
  d date;
begin
  select id into emp_id from employees where full_name ilike '%fatouma%' or full_name ilike '%neima%' limit 1;
  if emp_id is not null then
    for d in select generate_series('2026-07-01'::date, '2026-07-15'::date, '1 day'::interval)::date loop
      insert into hours_adjustments (employee_id, period_type, period_date, total_hours, note)
      values (emp_id, 'day', d, 0, 'Avant embauche (Fatouma commence le 16/07)')
      on conflict do nothing;
    end loop;
  end if;
end $$;

-- Vérification finale
select e.full_name, a.period_date, a.total_hours, a.note
from hours_adjustments a
join employees e on e.id = a.employee_id
where a.period_date >= '2026-07-01' and a.period_date <= '2026-07-31'
order by e.full_name, a.period_date;
