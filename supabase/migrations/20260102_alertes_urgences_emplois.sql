-- Nouvelles tables pour la phase 2 (alertes, urgences, emplois)

CREATE TABLE IF NOT EXISTS nouvelles_alertes (
  id int PRIMARY KEY DEFAULT 1,
  alertes jsonb DEFAULT '[]'::jsonb,
  nb_alertes int DEFAULT 0,
  mis_a_jour timestamptz DEFAULT now(),
  CONSTRAINT single_row_alertes CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS nouvelles_urgences (
  id int PRIMARY KEY DEFAULT 1,
  etablissements jsonb DEFAULT '[]'::jsonb,
  mis_a_jour timestamptz DEFAULT now(),
  CONSTRAINT single_row_urgences CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS nouvelles_emplois (
  id int PRIMARY KEY DEFAULT 1,
  nb_offres int DEFAULT 0,
  top_emplois jsonb DEFAULT '[]'::jsonb,
  mis_a_jour timestamptz DEFAULT now(),
  CONSTRAINT single_row_emplois CHECK (id = 1)
);

ALTER TABLE nouvelles_alertes ENABLE ROW LEVEL SECURITY;
ALTER TABLE nouvelles_urgences ENABLE ROW LEVEL SECURITY;
ALTER TABLE nouvelles_emplois ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='nouvelles_alertes' AND policyname='Allow public read') THEN
    CREATE POLICY "Allow public read" ON nouvelles_alertes FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='nouvelles_urgences' AND policyname='Allow public read') THEN
    CREATE POLICY "Allow public read" ON nouvelles_urgences FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='nouvelles_emplois' AND policyname='Allow public read') THEN
    CREATE POLICY "Allow public read" ON nouvelles_emplois FOR SELECT USING (true);
  END IF;
END $$;
