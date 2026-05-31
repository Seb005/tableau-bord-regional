-- Ajout du taux EUR/CAD et historique 7 jours pour le widget Devises
-- ----------------------------------------------------------------------
-- nouvelles_finances : ajoute taux_eur_cad + 3 colonnes de variation 7j
-- (or_variation_pct_7d, taux_usd_variation_pct_7d, taux_eur_variation_pct_7d)
-- nouvelles_finances_history : snapshot quotidien, source pour calcul 7j

alter table public.nouvelles_finances
  add column if not exists taux_eur_cad numeric,
  add column if not exists or_variation_pct_7d numeric,
  add column if not exists taux_usd_variation_pct_7d numeric,
  add column if not exists taux_eur_variation_pct_7d numeric;

create table if not exists public.nouvelles_finances_history (
  date date primary key,
  or_usd_oz numeric,
  taux_usd_cad numeric,
  taux_eur_cad numeric,
  created_at timestamptz not null default now()
);

create index if not exists nouvelles_finances_history_date_idx
  on public.nouvelles_finances_history(date desc);

-- RLS activée — seul le service_role (Netlify functions) accède à cette table.
alter table public.nouvelles_finances_history enable row level security;
