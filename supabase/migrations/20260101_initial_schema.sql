-- Page Nouvelles — Tables Supabase
-- Exécuter dans le SQL Editor du dashboard Supabase

-- Météo
CREATE TABLE IF NOT EXISTS nouvelles_meteo (
  id int PRIMARY KEY DEFAULT 1,
  temperature float,
  code_meteo int,
  vent_kmh float,
  humidite int,
  previsions jsonb DEFAULT '[]'::jsonb,
  mis_a_jour timestamptz DEFAULT now(),
  CONSTRAINT single_row_meteo CHECK (id = 1)
);

-- Essence
CREATE TABLE IF NOT EXISTS nouvelles_essence (
  id int PRIMARY KEY DEFAULT 1,
  prix_regulier float,
  prix_diesel float,
  station text,
  ville text,
  mis_a_jour timestamptz DEFAULT now(),
  CONSTRAINT single_row_essence CHECK (id = 1)
);

-- SOPFEU
CREATE TABLE IF NOT EXISTS nouvelles_sopfeu (
  id int PRIMARY KEY DEFAULT 1,
  niveau_danger text,
  indice_ifm float,
  zone text,
  feux_actifs int DEFAULT 0,
  saison_active boolean DEFAULT true,
  mis_a_jour timestamptz DEFAULT now(),
  CONSTRAINT single_row_sopfeu CHECK (id = 1)
);

-- Finances (or + taux de change)
CREATE TABLE IF NOT EXISTS nouvelles_finances (
  id int PRIMARY KEY DEFAULT 1,
  or_usd_oz float,
  or_cad_oz float,
  or_variation_pct float,
  taux_usd_cad float,
  taux_variation_pct float,
  mis_a_jour timestamptz DEFAULT now(),
  CONSTRAINT single_row_finances CHECK (id = 1)
);

-- Hydro-Québec
CREATE TABLE IF NOT EXISTS nouvelles_hydro (
  id int PRIMARY KEY DEFAULT 1,
  pannes_actives int DEFAULT 0,
  clients_touches int DEFAULT 0,
  details jsonb DEFAULT '[]'::jsonb,
  mis_a_jour timestamptz DEFAULT now(),
  CONSTRAINT single_row_hydro CHECK (id = 1)
);

-- Routes
CREATE TABLE IF NOT EXISTS nouvelles_routes (
  id int PRIMARY KEY DEFAULT 1,
  routes jsonb DEFAULT '[]'::jsonb,
  mis_a_jour timestamptz DEFAULT now(),
  CONSTRAINT single_row_routes CHECK (id = 1)
);

-- Articles (toutes sources confondues)
CREATE TABLE IF NOT EXISTS nouvelles_articles (
  id serial PRIMARY KEY,
  source text NOT NULL,
  titre text NOT NULL,
  url text UNIQUE NOT NULL,
  resume text,
  date_publication timestamptz,
  image_url text,
  mis_a_jour timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_articles_source ON nouvelles_articles(source);
CREATE INDEX IF NOT EXISTS idx_articles_date ON nouvelles_articles(date_publication DESC);

-- RLS: lecture publique sur toutes les tables
ALTER TABLE nouvelles_meteo ENABLE ROW LEVEL SECURITY;
ALTER TABLE nouvelles_essence ENABLE ROW LEVEL SECURITY;
ALTER TABLE nouvelles_sopfeu ENABLE ROW LEVEL SECURITY;
ALTER TABLE nouvelles_finances ENABLE ROW LEVEL SECURITY;
ALTER TABLE nouvelles_hydro ENABLE ROW LEVEL SECURITY;
ALTER TABLE nouvelles_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE nouvelles_articles ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='nouvelles_meteo' AND policyname='Allow public read') THEN
    CREATE POLICY "Allow public read" ON nouvelles_meteo FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='nouvelles_essence' AND policyname='Allow public read') THEN
    CREATE POLICY "Allow public read" ON nouvelles_essence FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='nouvelles_sopfeu' AND policyname='Allow public read') THEN
    CREATE POLICY "Allow public read" ON nouvelles_sopfeu FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='nouvelles_finances' AND policyname='Allow public read') THEN
    CREATE POLICY "Allow public read" ON nouvelles_finances FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='nouvelles_hydro' AND policyname='Allow public read') THEN
    CREATE POLICY "Allow public read" ON nouvelles_hydro FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='nouvelles_routes' AND policyname='Allow public read') THEN
    CREATE POLICY "Allow public read" ON nouvelles_routes FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='nouvelles_articles' AND policyname='Allow public read') THEN
    CREATE POLICY "Allow public read" ON nouvelles_articles FOR SELECT USING (true);
  END IF;
END $$;
