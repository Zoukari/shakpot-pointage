-- Ajouter les nouveaux articles à la liste de courses
insert into shopping_list_items (category, name, sort_order) values
('Emballages', 'Papier film', 10),
('Entretien', 'Asperox', 3),
('Entretien', 'Spray vitres', 4);

-- Vérification
select category, name from shopping_list_items where name in ('Papier film', 'Asperox', 'Spray vitres');
