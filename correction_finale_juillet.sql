-- ============================================
-- CORRECTION FINALE JUILLET 2026
-- Ajustements directs basés sur le rapport validé
-- ============================================

-- Supprimer les anciens ajustements de juillet (sauf Fatouma avant embauche)
delete from hours_adjustments
where period_date >= '2026-07-01'
  and period_date <= '2026-07-31'
  and note not ilike '%avant embauche%'
  and note not ilike '%absence%';

-- SAIDA : 233h55 payées (repos travaillé 7h48 exclu)
-- On crée un seul ajustement mensuel via une entrée sur le 1er du mois
-- En pratique on corrige jour par jour pour les cas spéciaux
-- et on ajoute un ajustement global pour compenser le manque de pointages

-- Ajustement global Saida : total juillet = 233h55 = 14035 min = 233.9167h
insert into hours_adjustments (employee_id, period_type, period_date, total_hours, note)
select id, 'month', '2026-07-01', 233.9167,
  'Correction juillet 2026 : 233h55 payées (rapport validé). Retards -4min, repos travaillé 13/07 crédité.'
from employees where full_name = 'Saida';

-- SALMA : 230h21 payées
-- 230h21 = 230 + 21/60 = 230.35h
insert into hours_adjustments (employee_id, period_type, period_date, total_hours, note)
select id, 'month', '2026-07-01', 230.35,
  'Correction juillet 2026 : 230h21 payées (rapport validé). Retards -3h34, correction +5h00.'
from employees where full_name = 'Salma';

-- HABSA : 169h04 payées
-- 169h04 = 169 + 4/60 = 169.0667h
insert into hours_adjustments (employee_id, period_type, period_date, total_hours, note)
select id, 'month', '2026-07-01', 169.0667,
  'Correction juillet 2026 : 169h04 payées (rapport validé). Commence le 08/07, retards -10h48, absence 23/07.'
from employees where full_name = 'Habsa';

-- FATOUMA : 124h00 payées
insert into hours_adjustments (employee_id, period_type, period_date, total_hours, note)
select id, 'month', '2026-07-01', 124.0,
  'Correction juillet 2026 : 124h00 payées (rapport validé). Commence le 16/07.'
from employees where full_name = 'Fatouma';

-- Vérification
select e.full_name,
  a.total_hours,
  floor(a.total_hours) || 'h' || lpad(round((a.total_hours - floor(a.total_hours)) * 60)::text, 2, '0') as heures_fmt,
  round(a.total_hours * e.hourly_rate) as salaire_fdj,
  a.note
from hours_adjustments a
join employees e on e.id = a.employee_id
where a.period_type = 'month'
  and a.period_date = '2026-07-01'
order by e.full_name;
