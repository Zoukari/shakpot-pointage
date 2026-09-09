-- Salaires août 2026 (payés en septembre)
-- Ajustements mensuels directs

-- Supprimer les anciens ajustements mensuels d'août si besoin
delete from hours_adjustments
where period_type = 'month'
  and period_date = '2026-08-01';

-- Insérer les salaires validés
-- On stocke directement les heures implicites (salaire / taux horaire)
-- pour que le système affiche le bon salaire

-- Hasna : 66 000 FDJ
insert into hours_adjustments (employee_id, period_type, period_date, total_hours, note)
select id, 'month', '2026-08-01',
  round(66000.0 / nullif(hourly_rate, 0), 4),
  'Salaire août 2026 validé : 66 000 FDJ'
from employees where full_name ilike '%hasna%';

-- Salma : 16 600 FDJ
insert into hours_adjustments (employee_id, period_type, period_date, total_hours, note)
select id, 'month', '2026-08-01',
  round(16600.0 / nullif(hourly_rate, 0), 4),
  'Salaire août 2026 validé : 16 600 FDJ'
from employees where full_name ilike '%salma%';

-- Saida : 55 000 FDJ
insert into hours_adjustments (employee_id, period_type, period_date, total_hours, note)
select id, 'month', '2026-08-01',
  round(55000.0 / nullif(hourly_rate, 0), 4),
  'Salaire août 2026 validé : 55 000 FDJ'
from employees where full_name ilike '%saida%';

-- Fatouma : 30 000 FDJ
insert into hours_adjustments (employee_id, period_type, period_date, total_hours, note)
select id, 'month', '2026-08-01',
  round(30000.0 / nullif(hourly_rate, 0), 4),
  'Salaire août 2026 validé : 30 000 FDJ'
from employees where full_name ilike '%fatouma%';

-- Samatar : 15 500 FDJ
insert into hours_adjustments (employee_id, period_type, period_date, total_hours, note)
select id, 'month', '2026-08-01',
  round(15500.0 / nullif(hourly_rate, 0), 4),
  'Salaire août 2026 validé : 15 500 FDJ'
from employees where full_name ilike '%samatar%';

-- Amira : 16 000 FDJ
insert into hours_adjustments (employee_id, period_type, period_date, total_hours, note)
select id, 'month', '2026-08-01',
  round(16000.0 / nullif(hourly_rate, 0), 4),
  'Salaire août 2026 validé : 16 000 FDJ'
from employees where full_name ilike '%amira%';

-- Habsa : 10 900 FDJ
insert into hours_adjustments (employee_id, period_type, period_date, total_hours, note)
select id, 'month', '2026-08-01',
  round(10900.0 / nullif(hourly_rate, 0), 4),
  'Salaire août 2026 validé : 10 900 FDJ'
from employees where full_name ilike '%habsa%';

-- Gardien : 10 000 FDJ
insert into hours_adjustments (employee_id, period_type, period_date, total_hours, note)
select id, 'month', '2026-08-01',
  round(10000.0 / nullif(hourly_rate, 0), 4),
  'Salaire août 2026 validé : 10 000 FDJ'
from employees where full_name ilike '%gardien%';

-- Vérification
select 
  e.full_name,
  a.total_hours,
  e.hourly_rate,
  round(a.total_hours * e.hourly_rate) as salaire_calcule,
  a.note
from hours_adjustments a
join employees e on e.id = a.employee_id
where a.period_type = 'month'
  and a.period_date = '2026-08-01'
order by e.full_name;
