-- Nouveau rôle : accès liste de courses
alter table employees add column if not exists liste_courses_access boolean default false;

-- Table pour la liste de courses (items modifiables depuis l'admin)
create table if not exists shopping_list_items (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  name text not null,
  sort_order integer default 0,
  active boolean default true,
  created_at timestamptz default now()
);
alter table shopping_list_items enable row level security;
create policy "Allow all on shopping_list_items" on shopping_list_items
  for all using (true) with check (true);

-- Table pour les contacts WhatsApp
create table if not exists whatsapp_contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  active boolean default true
);
alter table whatsapp_contacts enable row level security;
create policy "Allow all on whatsapp_contacts" on whatsapp_contacts
  for all using (true) with check (true);

-- Insérer la liste maître initiale
insert into shopping_list_items (category, name, sort_order) values
-- Viandes
('Viandes', 'Poulet (filet)', 1),
('Viandes', 'Poulet (cuisses)', 2),
('Viandes', 'Nuggets', 3),
('Viandes', 'Cordon bleu', 4),
('Viandes', 'Viande hachée', 5),
('Viandes', 'Merguez', 6),
-- Pains & Galettes
('Pains & Galettes', 'Galette 12', 1),
('Pains & Galettes', 'Galette 10', 2),
('Pains & Galettes', 'Pain burger', 3),
('Pains & Galettes', 'Pain panini', 4),
-- Produits laitiers
('Produits laitiers', 'Crème fraîche', 1),
('Produits laitiers', 'Emmental', 2),
('Produits laitiers', 'Cheddar', 3),
('Produits laitiers', 'Fromage La Vache Qui Rit', 4),
('Produits laitiers', 'Lait concentré', 5),
('Produits laitiers', 'Lait en poudre', 6),
('Produits laitiers', 'Mozzarella', 7),
-- Surgelés
('Surgelés', 'Frites congelées', 1),
-- Sauces
('Sauces', 'Mayonnaise (petit)', 1),
('Sauces', 'Mayonnaise (grand pot)', 2),
('Sauces', 'Ketchup', 3),
('Sauces', 'Sauce barbecue', 4),
('Sauces', 'Sweet Chili', 5),
('Sauces', 'Harissa', 6),
('Sauces', 'Moutarde', 7),
-- Légumes & Condiments
('Légumes & Condiments', 'Pommes de terre', 1),
('Légumes & Condiments', 'Salade', 2),
('Légumes & Condiments', 'Cornichons', 3),
('Légumes & Condiments', 'Jalapeños', 4),
('Légumes & Condiments', 'Champignons', 5),
('Légumes & Condiments', 'Maïs', 6),
('Légumes & Condiments', 'Gingembre', 7),
('Légumes & Condiments', 'Ail', 8),
('Légumes & Condiments', 'Piment rouge en poudre', 9),
('Légumes & Condiments', 'Piment vert', 10),
('Légumes & Condiments', 'Citron', 11),
('Légumes & Condiments', 'Citron en poudre', 12),
('Légumes & Condiments', 'Paprika fumé', 13),
('Légumes & Condiments', 'Cumin', 14),
('Légumes & Condiments', 'Épices poulet mariné', 15),
('Légumes & Condiments', 'Miel', 16),
-- Emballages
('Emballages', 'Boîte de sauce', 1),
('Emballages', 'Boîte de burger', 2),
('Emballages', 'Boîte de frites', 3),
('Emballages', 'Bowls', 4),
('Emballages', 'Emballage burger', 5),
('Emballages', 'Papier aluminium', 6),
('Emballages', 'Sachets plastiques', 7),
('Emballages', 'Fourchettes', 8),
('Emballages', 'Gobelets', 9),
-- Épicerie / Divers
('Épicerie / Divers', 'Huile', 1),
('Épicerie / Divers', 'Œufs', 2),
('Épicerie / Divers', 'Pain sec', 3),
('Épicerie / Divers', 'Sirop cassis', 4),
('Épicerie / Divers', 'Lait de coco', 5),
-- Entretien
('Entretien', 'Sopalin', 1),
('Entretien', 'Javel', 2),
('Entretien', 'Asperox', 3),
('Entretien', 'Spray vitres', 4),
('Entretien', 'Gants', 5),
('Entretien', 'Sacs poubelle', 6),
('Entretien', 'Torchons', 7),
-- Fournitures
('Fournitures', 'Rouleau imprimante', 1),
('Fournitures', 'Marqueurs', 2),
('Fournitures', 'Stylos', 3),
('Fournitures', 'Cahier', 4),
('Fournitures', 'Agrafes', 5);
