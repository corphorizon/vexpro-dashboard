-- ================================================
-- FINANCIAL DASHBOARD - SEED DATA
-- Inserts all demo data for Vex Pro into Supabase tables.
--
-- Uses uuid_generate_v5() with a fixed namespace to derive deterministic
-- UUIDs from human-readable text IDs (e.g. 'vexpro-001' -> stable UUID).
-- This makes the seed idempotent: running it multiple times produces the
-- same UUIDs, and ON CONFLICT DO NOTHING prevents duplicate inserts.
--
-- Requires: CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
-- ================================================

-- Ensure uuid-ossp is available (Supabase has it by default)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Fixed namespace UUID for deterministic ID generation
-- Using DNS namespace as base: 6ba7b810-9dad-11d1-80b4-00c04fd430c8
-- We create our own app namespace from it:
DO $$
DECLARE
  ns UUID := uuid_generate_v5('6ba7b810-9dad-11d1-80b4-00c04fd430c8'::uuid, 'financial-dashboard-demo');
BEGIN
  RAISE NOTICE 'Using namespace: %', ns;
END $$;

BEGIN;

-- ============================================================
-- Helper: deterministic UUID function for this seed
-- ============================================================
CREATE OR REPLACE FUNCTION _seed_id(text_id TEXT) RETURNS UUID AS $$
  SELECT uuid_generate_v5(
    uuid_generate_v5('6ba7b810-9dad-11d1-80b4-00c04fd430c8'::uuid, 'financial-dashboard-demo'),
    text_id
  );
$$ LANGUAGE SQL IMMUTABLE;


-- ============================================================
-- 1. COMPANIES
-- ============================================================
INSERT INTO companies (id, name, slug, subdomain, logo_url, color_primary, color_secondary, currency, active_modules)
VALUES (
  _seed_id('vexpro-001'),
  'Vex Pro',
  'vexprofx',
  'dashboard.vexprofx.com',
  NULL,
  '#1E3A5F',
  '#3B82F6',
  'USD',
  ARRAY['summary','movements','expenses','liquidity','investments','partners']
)
ON CONFLICT DO NOTHING;


-- ============================================================
-- 2. PERIODS
-- ============================================================
INSERT INTO periods (id, company_id, year, month, label, is_closed) VALUES
  (_seed_id('p-oct-25'), _seed_id('vexpro-001'), 2025, 10, 'Oct 25', true),
  (_seed_id('p-nov-25'), _seed_id('vexpro-001'), 2025, 11, 'Nov 25', true),
  (_seed_id('p-dic-25'), _seed_id('vexpro-001'), 2025, 12, 'Dic 25', true),
  (_seed_id('p-jan-26'), _seed_id('vexpro-001'), 2026, 1, 'Ene 26', true),
  (_seed_id('p-feb-26'), _seed_id('vexpro-001'), 2026, 2, 'Feb 26', true),
  (_seed_id('p-mar-26'), _seed_id('vexpro-001'), 2026, 3, 'Mar 26', false),
  (_seed_id('p-apr-26'), _seed_id('vexpro-001'), 2026, 4, 'Abr 26', false)
ON CONFLICT DO NOTHING;


-- ============================================================
-- 3. DEPOSITS (28 entries)
-- ============================================================
INSERT INTO deposits (id, period_id, company_id, channel, amount, notes) VALUES
  -- Oct 25
  (_seed_id('d1'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'coinsbuy', 73599, NULL),
  (_seed_id('d2'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'fairpay', 0, NULL),
  (_seed_id('d3'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'unipayment', 3465, NULL),
  (_seed_id('d4'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'other', 0, NULL),
  -- Nov 25
  (_seed_id('d5'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'coinsbuy', 505300, NULL),
  (_seed_id('d6'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'fairpay', 405.77, NULL),
  (_seed_id('d7'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'unipayment', 10849.39, NULL),
  (_seed_id('d8'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'other', 0, NULL),
  -- Dic 25
  (_seed_id('d9'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'coinsbuy', 665309, NULL),
  (_seed_id('d10'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'fairpay', 4197.71, NULL),
  (_seed_id('d11'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'unipayment', 17769, NULL),
  (_seed_id('d12'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'other', 0, NULL),
  -- Jan 26
  (_seed_id('d13'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'coinsbuy', 294664, NULL),
  (_seed_id('d14'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'fairpay', 2431.47, NULL),
  (_seed_id('d15'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'unipayment', 12172.42, NULL),
  (_seed_id('d16'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'other', 0, NULL),
  -- Feb 26
  (_seed_id('d17'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'coinsbuy', 245907.23, NULL),
  (_seed_id('d18'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'fairpay', 4278, NULL),
  (_seed_id('d19'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'unipayment', 18875.74, NULL),
  (_seed_id('d20'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'other', 17175, NULL),
  -- Mar 26
  (_seed_id('d21'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'coinsbuy', 0, NULL),
  (_seed_id('d22'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'fairpay', 0, NULL),
  (_seed_id('d23'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'unipayment', 0, NULL),
  (_seed_id('d24'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'other', 6200, NULL),
  -- Apr 26
  (_seed_id('d25'), _seed_id('p-apr-26'), _seed_id('vexpro-001'), 'coinsbuy', 0, NULL),
  (_seed_id('d26'), _seed_id('p-apr-26'), _seed_id('vexpro-001'), 'fairpay', 0, NULL),
  (_seed_id('d27'), _seed_id('p-apr-26'), _seed_id('vexpro-001'), 'unipayment', 0, NULL),
  (_seed_id('d28'), _seed_id('p-apr-26'), _seed_id('vexpro-001'), 'other', 0, NULL)
ON CONFLICT DO NOTHING;


-- ============================================================
-- 4. WITHDRAWALS (28 entries)
-- ============================================================
INSERT INTO withdrawals (id, period_id, company_id, category, amount, notes) VALUES
  -- Oct 25
  (_seed_id('w1'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'ib_commissions', 0, NULL),
  (_seed_id('w2'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'broker', 23493.04, NULL),
  (_seed_id('w3'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'prop_firm', 587.96, NULL),
  (_seed_id('w4'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'other', 0, NULL),
  -- Nov 25
  (_seed_id('w5'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'ib_commissions', 27916.16, NULL),
  (_seed_id('w6'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'broker', 193080.1, NULL),
  (_seed_id('w7'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'prop_firm', 2115.3, NULL),
  (_seed_id('w8'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'other', 0, NULL),
  -- Dic 25
  (_seed_id('w9'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'ib_commissions', 62943.39, NULL),
  (_seed_id('w10'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'broker', 429969.41, NULL),
  (_seed_id('w11'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'prop_firm', 5416.2, NULL),
  (_seed_id('w12'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'other', 0, NULL),
  -- Jan 26
  (_seed_id('w13'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'ib_commissions', 47571.75, NULL),
  (_seed_id('w14'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'broker', 337206.46, NULL),
  (_seed_id('w15'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'prop_firm', 5888.5, NULL),
  (_seed_id('w16'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'other', 0, NULL),
  -- Feb 26
  (_seed_id('w17'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'ib_commissions', 0, NULL),
  (_seed_id('w18'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'broker', 217421, NULL),
  (_seed_id('w19'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'prop_firm', 0, NULL),
  (_seed_id('w20'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'other', 0, NULL),
  -- Mar 26
  (_seed_id('w21'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'ib_commissions', 0, NULL),
  (_seed_id('w22'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'broker', 0, NULL),
  (_seed_id('w23'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'prop_firm', 0, NULL),
  (_seed_id('w24'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'other', 0, NULL),
  -- Apr 26
  (_seed_id('w25'), _seed_id('p-apr-26'), _seed_id('vexpro-001'), 'ib_commissions', 0, NULL),
  (_seed_id('w26'), _seed_id('p-apr-26'), _seed_id('vexpro-001'), 'broker', 0, NULL),
  (_seed_id('w27'), _seed_id('p-apr-26'), _seed_id('vexpro-001'), 'prop_firm', 0, NULL),
  (_seed_id('w28'), _seed_id('p-apr-26'), _seed_id('vexpro-001'), 'other', 0, NULL)
ON CONFLICT DO NOTHING;


-- ============================================================
-- 5. PROP FIRM SALES (7 entries)
-- ============================================================
INSERT INTO prop_firm_sales (id, period_id, company_id, amount) VALUES
  (_seed_id('pfs1'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 4883),
  (_seed_id('pfs2'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 14061),
  (_seed_id('pfs3'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 9709),
  (_seed_id('pfs4'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 16778),
  (_seed_id('pfs5'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 51409.65),
  (_seed_id('pfs6'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 0),
  (_seed_id('pfs7'), _seed_id('p-apr-26'), _seed_id('vexpro-001'), 0)
ON CONFLICT DO NOTHING;


-- ============================================================
-- 6. P2P TRANSFERS (7 entries)
-- ============================================================
INSERT INTO p2p_transfers (id, period_id, company_id, amount) VALUES
  (_seed_id('p2p1'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 0),
  (_seed_id('p2p2'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 9787.04),
  (_seed_id('p2p3'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 0),
  (_seed_id('p2p4'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 0),
  (_seed_id('p2p5'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0),
  (_seed_id('p2p6'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 0),
  (_seed_id('p2p7'), _seed_id('p-apr-26'), _seed_id('vexpro-001'), 0)
ON CONFLICT DO NOTHING;


-- ============================================================
-- 7. EXPENSES (139 entries)
-- ============================================================
INSERT INTO expenses (id, period_id, company_id, concept, amount, paid, pending, category, sort_order) VALUES
  -- Oct 25 (Sep category)
  (_seed_id('e1'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Internet ago', 50.7, 50.7, 0, 'sep', 1),
  (_seed_id('e2'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'FX EXPO Medellin', 4641, 4641, 0, 'sep', 2),
  (_seed_id('e3'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Administracion Ofi Mexico (Ago/sep)', 708.3, 708.3, 0, 'sep', 3),
  (_seed_id('e4'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Energia agos', 67.49, 67.49, 0, 'sep', 4),
  (_seed_id('e5'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Verificacion Doc', 544.58, 544.58, 0, 'sep', 5),
  (_seed_id('e6'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Deposito Inflable expo', 158, 158, 0, 'sep', 6),
  (_seed_id('e7'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Cambio logos Vertex a Vex', 325, 325, 0, 'sep', 7),
  (_seed_id('e8'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Docu/ chipre Meta Trader', 64.44, 64.44, 0, 'sep', 8),
  (_seed_id('e9'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'OVH Servers', 149, 149, 0, 'sep', 9),
  (_seed_id('e10'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Resenas Trust Pilot', 310, 310, 0, 'sep', 10),
  (_seed_id('e11'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Correos Vex GODADDY', 106.45, 106.45, 0, 'sep', 11),
  (_seed_id('e12'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Apoyo BDM Expo Transp / Hosp AED', 2076.88, 2076.88, 0, 'sep', 12),
  (_seed_id('e13'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Apoyos BDM Expo Transp / Cena USD', 512, 512, 0, 'sep', 13),
  (_seed_id('e14'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Unipayment Setup', 1792.5, 1792.5, 0, 'sep', 14),
  (_seed_id('e15'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Correos Vex y Zoom Corporativo', 152, 152, 0, 'sep', 15),
  -- Oct 25 (Oct category)
  (_seed_id('e16'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Egresos cuenta bancaria', 343, 343, 0, 'oct', 16),
  (_seed_id('e17'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Pago servers.com', 602.12, 602.12, 0, 'oct', 17),
  (_seed_id('e18'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Pago Sendgrid', 125, 125, 0, 'oct', 18),
  (_seed_id('e19'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Pago servers OVH', 546.38, 546.38, 0, 'oct', 19),
  (_seed_id('e20'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Pago COO Daniela', 800, 800, 0, 'oct', 20),
  (_seed_id('e21'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Pago Legal Team | Sofia', 200, 200, 0, 'oct', 21),
  (_seed_id('e22'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Disenador Grafico', 750, 750, 0, 'oct', 22),
  (_seed_id('e23'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Equipo soporte', 300, 300, 0, 'oct', 23),
  (_seed_id('e24'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Community Manager', 150, 150, 0, 'oct', 24),
  (_seed_id('e25'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'CRM Servers', 2000, 2000, 0, 'oct', 25),
  (_seed_id('e26'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Manejo servers/Sinteticos/Controladas', 3750, 3750, 0, 'oct', 26),
  (_seed_id('e27'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Oficina Mexico Admin y Servicios', 405.7, 405.7, 0, 'oct', 27),
  (_seed_id('e28'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Hoteles y Hospedaje BDM', 1135.2, 1135.2, 0, 'oct', 28),
  (_seed_id('e29'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Correos Empresa outlook', 152.15, 152.15, 0, 'oct', 29),
  (_seed_id('e30'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Pago Oficina Guadalajara', 10955, 10955, 0, 'oct', 30),
  (_seed_id('e31'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Cambios empresa Dubai', 1415, 1415, 0, 'oct', 31),
  (_seed_id('e32'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Presupuesto ADS', 500, 500, 0, 'oct', 32),
  (_seed_id('e33'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 'Fee BNB', 10, 10, 0, 'oct', 33),
  -- Nov 25
  (_seed_id('e34'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'Egresos cuenta bancaria', 2490, 2490, 0, NULL, 1),
  (_seed_id('e35'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'Pago servers.com', 600, 600, 0, NULL, 2),
  (_seed_id('e36'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'Pago Sendgrid', 125, 125, 0, NULL, 3),
  (_seed_id('e37'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'Pago servers OVH', 400, 400, 0, NULL, 4),
  (_seed_id('e38'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'Pago COO Daniela', 800, 800, 0, NULL, 5),
  (_seed_id('e39'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'Pago Legal Team | Sofia', 200, 200, 0, NULL, 6),
  (_seed_id('e40'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'Disenador Grafico', 750, 750, 0, NULL, 7),
  (_seed_id('e41'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'Equipo soporte', 350, 350, 0, NULL, 8),
  (_seed_id('e42'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'Community Manager', 200, 200, 0, NULL, 9),
  (_seed_id('e43'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'Trafficker', 750, 750, 0, NULL, 10),
  (_seed_id('e44'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'CRM + Social Trading (40% off)', 6000, 6000, 0, NULL, 11),
  (_seed_id('e45'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'Manejo servers/Sinteticos/Controladas', 4500, 4500, 0, NULL, 12),
  (_seed_id('e46'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'Metaquotes', 0, 0, 0, NULL, 13),
  (_seed_id('e47'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'Alquiler Oficina Mexico', 10200, 10200, 0, NULL, 14),
  (_seed_id('e48'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'Oficina Mexico Admin y Servicios', 405.7, 405.7, 0, NULL, 15),
  (_seed_id('e49'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'FX Expo Lima VexPro', 13436, 13436, 0, NULL, 16),
  (_seed_id('e50'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'FX Expo Lima Exura 20%', 565, 565, 0, NULL, 17),
  (_seed_id('e51'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'Vuelos FX EXPO Lima', 2429, 2429, 0, NULL, 18),
  (_seed_id('e52'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'Equipo Dealing', 950, 950, 0, NULL, 19),
  (_seed_id('e53'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'Acuerdo Sebastian Molina', 15000, 15000, 0, NULL, 20),
  (_seed_id('e54'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'Adelanto Manuel Felipe', 2000, 2000, 0, NULL, 21),
  (_seed_id('e55'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'Asado y vuelo extra Expo Lima', 550, 550, 0, NULL, 22),
  (_seed_id('e56'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'Airbnb Expo Lima', 755, 755, 0, NULL, 23),
  (_seed_id('e57'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'Servidores Webs VEX (Hasta Enero)', 1000, 1000, 0, NULL, 24),
  (_seed_id('e58'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'Verificacion Instagram', 24, 24, 0, NULL, 25),
  (_seed_id('e59'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'Trust Pilot', 100, 100, 0, NULL, 26),
  (_seed_id('e60'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 'Cena Bucaramanga', 53, 53, 0, NULL, 27),
  -- Dic 25
  (_seed_id('e61'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'Egresos cuenta bancaria', 1855, 1855, 0, NULL, 1),
  (_seed_id('e62'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'Pago servers.com', 593.85, 593.85, 0, NULL, 2),
  (_seed_id('e63'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'Pago Sendgrid', 125, 125, 0, NULL, 3),
  (_seed_id('e64'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'Pago servers OVH', 178, 178, 0, NULL, 4),
  (_seed_id('e65'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'Centroid', 1000, 1000, 0, NULL, 5),
  (_seed_id('e66'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'B2Prime Liquidez', 1500, 1500, 0, NULL, 6),
  (_seed_id('e67'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'Pago COO Daniela', 800, 800, 0, NULL, 7),
  (_seed_id('e68'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'Pago Legal Team | Sofia', 200, 200, 0, NULL, 8),
  (_seed_id('e69'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'Disenador Grafico', 750, 750, 0, NULL, 9),
  (_seed_id('e70'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'Equipo soporte', 800, 800, 0, NULL, 10),
  (_seed_id('e71'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'Community Manager', 200, 200, 0, NULL, 11),
  (_seed_id('e72'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'Trafficker', 750, 750, 0, NULL, 12),
  (_seed_id('e73'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'CRM + Social Trading', 10000, 10000, 0, NULL, 13),
  (_seed_id('e74'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'Manejo servers/Sinteticos/Controladas', 4500, 4500, 0, NULL, 14),
  (_seed_id('e75'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'Metaquotes', 15295, 15295, 0, NULL, 15),
  (_seed_id('e76'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'Oficina Mexico Admin y Servicios', 495, 495, 0, NULL, 16),
  (_seed_id('e77'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'Equipo Dealing', 1500, 1500, 0, NULL, 17),
  (_seed_id('e78'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'Renovacion Vex Development Dubai', 5340, 5340, 0, NULL, 18),
  (_seed_id('e79'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'Contabilidad Vex Dev. - 3 Meses', 1030, 1030, 0, NULL, 19),
  (_seed_id('e80'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'Viaticos Equipo Exura', 200, 200, 0, NULL, 20),
  (_seed_id('e81'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'FX EXPO Guadalajara', 10000, 10000, 0, NULL, 21),
  (_seed_id('e82'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 'Bono a Juan', 50, 50, 0, NULL, 22),
  -- Jan 26
  (_seed_id('e83'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'Egresos cuenta bancaria', 762.62, 762.62, 0, NULL, 1),
  (_seed_id('e84'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'Pago servers.com', 593.85, 593.85, 0, NULL, 2),
  (_seed_id('e85'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'Pago Sendgrid', 125, 125, 0, NULL, 3),
  (_seed_id('e86'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'Pago servers OVH', 178, 178, 0, NULL, 4),
  (_seed_id('e87'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'Centroid', 1000, 1000, 0, NULL, 5),
  (_seed_id('e88'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'B2Prime Liquidez', 1500, 1500, 0, NULL, 6),
  (_seed_id('e89'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'Pago COO Daniela', 800, 800, 0, NULL, 7),
  (_seed_id('e90'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'Pago Legal Team | Sofia', 200, 200, 0, NULL, 8),
  (_seed_id('e91'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'Disenador Grafico', 750, 750, 0, NULL, 9),
  (_seed_id('e92'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'Equipo soporte', 800, 800, 0, NULL, 10),
  (_seed_id('e93'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'Community Manager', 200, 200, 0, NULL, 11),
  (_seed_id('e94'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'Trafficker', 750, 750, 0, NULL, 12),
  (_seed_id('e95'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'CRM + Social Trading', 10000, 10000, 0, NULL, 13),
  (_seed_id('e96'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'Manejo servers/Sinteticos/Controladas', 4500, 4500, 0, NULL, 14),
  (_seed_id('e97'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'Metaquotes', 15295, 15295, 0, NULL, 15),
  (_seed_id('e98'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'Oficina Mexico Admin y Servicios', 495, 495, 0, NULL, 16),
  (_seed_id('e99'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'Equipo Dealing', 1500, 1500, 0, NULL, 17),
  (_seed_id('e100'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 'Oficina 3 Meses', 11680, 11680, 0, NULL, 18),
  -- Feb 26
  (_seed_id('e101'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'Egresos cuenta bancaria', 1393.6, 1393.6, 0, NULL, 1),
  (_seed_id('e102'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'Pago servers.com', 604, 604, 0, NULL, 2),
  (_seed_id('e103'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'Pago Sendgrid', 125, 125, 0, NULL, 3),
  (_seed_id('e104'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'Pago servers OVH', 178, 178, 0, NULL, 4),
  (_seed_id('e105'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'Centroid', 1000, 1000, 0, NULL, 5),
  (_seed_id('e106'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'B2Prime Liquidez', 1500, 1500, 0, NULL, 6),
  (_seed_id('e107'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'Pago COO Daniela', 800, 800, 0, NULL, 7),
  (_seed_id('e108'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'Pago Legal Team | Sofia', 200, 200, 0, NULL, 8),
  (_seed_id('e109'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'Disenador Grafico', 750, 750, 0, NULL, 9),
  (_seed_id('e110'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'Equipo soporte', 800, 800, 0, NULL, 10),
  (_seed_id('e111'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'Community Manager', 200, 200, 0, NULL, 11),
  (_seed_id('e112'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'Trafficker', 750, 750, 0, NULL, 12),
  (_seed_id('e113'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'CRM + Social Trading', 10000, 10000, 0, NULL, 13),
  (_seed_id('e114'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'Manejo servers/Sinteticos/Controladas', 4500, 4500, 0, NULL, 14),
  (_seed_id('e115'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'Metaquotes', 15295, 15295, 0, NULL, 15),
  (_seed_id('e116'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'Oficina Mexico Admin y Servicios', 500, 500, 0, NULL, 16),
  (_seed_id('e117'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'Equipo Dealing', 1500, 1500, 0, NULL, 17),
  (_seed_id('e118'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'Regulacion SCA', 20000, 20000, 0, NULL, 18),
  (_seed_id('e119'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'Empresa USA', 3500, 3500, 0, NULL, 19),
  (_seed_id('e120'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 'Contabilidad empresa Dubai', 1030, 1030, 0, NULL, 20),
  -- Mar 26
  (_seed_id('e121'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'Pago servers.com', 730, 730, 0, NULL, 1),
  (_seed_id('e122'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'Pago Sendgrid', 150, 150, 0, NULL, 2),
  (_seed_id('e123'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'Pago servers OVH', 178, 178, 0, NULL, 3),
  (_seed_id('e124'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'Centroid', 1000, 1000, 0, NULL, 4),
  (_seed_id('e125'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'B2Prime Liquidez', 1500, 1500, 0, NULL, 5),
  (_seed_id('e126'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'Recursos Humanos | Daniela', 800, 800, 0, NULL, 6),
  (_seed_id('e127'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'Directora Legal | Sofia', 250, 250, 0, NULL, 7),
  (_seed_id('e128'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'Disenador Grafico | Jonathan', 750, 750, 0, NULL, 8),
  (_seed_id('e129'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'Equipo soporte | Juan Miguel y Sebas', 900, 900, 0, NULL, 9),
  (_seed_id('e130'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'Community Manager | Liseth', 200, 200, 0, NULL, 10),
  (_seed_id('e131'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'Director Comercial | Brandon', 1400, 1400, 0, NULL, 11),
  (_seed_id('e132'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'IT | Daniel', 650, 650, 0, NULL, 12),
  (_seed_id('e133'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'CRM + Social Trading', 10000, 10000, 0, NULL, 13),
  (_seed_id('e134'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'Manejo servers/Sinteticos/Controladas', 5100, 5100, 0, NULL, 14),
  (_seed_id('e135'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'Metaquotes', 15295, 15295, 0, NULL, 15),
  (_seed_id('e136'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'Oficina Mexico Admin y Servicios', 500, 500, 0, NULL, 16),
  (_seed_id('e137'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'Equipo Dealing', 2500, 2500, 0, NULL, 17),
  (_seed_id('e138'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'FX Expo Guadalajara', 5917, 5917, 0, NULL, 18),
  (_seed_id('e139'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 'Gastos FX EXPO e INAUGURACION', 19432, 19432, 0, NULL, 19)
ON CONFLICT DO NOTHING;


-- ============================================================
-- 8. PREOPERATIVE EXPENSES (36 entries)
-- ============================================================
INSERT INTO preoperative_expenses (id, company_id, concept, amount, paid, pending, sort_order) VALUES
  (_seed_id('pre1'), _seed_id('vexpro-001'), 'CRM MMtech', 21000, 21000, 0, 1),
  (_seed_id('pre2'), _seed_id('vexpro-001'), 'Equipo Diseno', 1500, 1500, 0, 2),
  (_seed_id('pre3'), _seed_id('vexpro-001'), 'Community Manager', 500, 500, 0, 3),
  (_seed_id('pre4'), _seed_id('vexpro-001'), 'Equipo Soporte (Daniel y Manuela)', 1000, 1000, 0, 4),
  (_seed_id('pre5'), _seed_id('vexpro-001'), 'Sitio web Vertex', 1500, 1500, 0, 5),
  (_seed_id('pre6'), _seed_id('vexpro-001'), 'Hosting y Dominio', 553.03, 553.03, 0, 6),
  (_seed_id('pre7'), _seed_id('vexpro-001'), 'Disenos web grupo financiero', 2000, 2000, 0, 7),
  (_seed_id('pre8'), _seed_id('vexpro-001'), 'Correos Google', 63, 63, 0, 8),
  (_seed_id('pre9'), _seed_id('vexpro-001'), 'Correos Outlook', 100.2, 100.2, 0, 9),
  (_seed_id('pre10'), _seed_id('vexpro-001'), 'Cuentas Bancarias', 6000, 6000, 0, 10),
  (_seed_id('pre11'), _seed_id('vexpro-001'), 'Empresa Saint Lucia', 5500, 5500, 0, 11),
  (_seed_id('pre12'), _seed_id('vexpro-001'), 'Empresa Mexico', 3000, 3000, 0, 12),
  (_seed_id('pre13'), _seed_id('vexpro-001'), 'Arrendamiento Oficina Mexico Agosto', 10200, 10200, 0, 13),
  (_seed_id('pre14'), _seed_id('vexpro-001'), 'Metaquotes', 31269, 31269, 0, 14),
  (_seed_id('pre15'), _seed_id('vexpro-001'), 'CRM + Social Trading', 16000, 16000, 0, 15),
  (_seed_id('pre16'), _seed_id('vexpro-001'), 'Manejo servers/Sinteticos/Controladas', 4750, 4750, 0, 16),
  (_seed_id('pre17'), _seed_id('vexpro-001'), 'Pago Sendgrid', 150, 150, 0, 17),
  (_seed_id('pre18'), _seed_id('vexpro-001'), 'Empresas grupo financiero', 12459.4, 12459.4, 0, 18),
  (_seed_id('pre19'), _seed_id('vexpro-001'), 'Citas SAT', 304, 304, 0, 19),
  (_seed_id('pre20'), _seed_id('vexpro-001'), 'Presta nombre adicional', 101, 101, 0, 20),
  (_seed_id('pre21'), _seed_id('vexpro-001'), 'Instalacion de letreros', 1515, 1515, 0, 21),
  (_seed_id('pre22'), _seed_id('vexpro-001'), 'Abogado cambio de nombre legal', 646, 646, 0, 22),
  (_seed_id('pre23'), _seed_id('vexpro-001'), 'Traduccion documentos + contratos', 500, 500, 0, 23),
  (_seed_id('pre24'), _seed_id('vexpro-001'), 'Internet no cancelado (6 meses)', 424, 424, 0, 24),
  (_seed_id('pre25'), _seed_id('vexpro-001'), 'Deposito cuenta bancaria', 3000, 3000, 0, 25),
  (_seed_id('pre26'), _seed_id('vexpro-001'), 'Oficina feb-julio (6 meses)', 16200, 16200, 0, 26),
  (_seed_id('pre27'), _seed_id('vexpro-001'), 'Mantenimiento edificio (6 meses)', 1200, 1200, 0, 27),
  (_seed_id('pre28'), _seed_id('vexpro-001'), 'Gastos Filipinas (5 personas x 30 USD)', 150, 150, 0, 28),
  (_seed_id('pre29'), _seed_id('vexpro-001'), 'Cena para fotos', 166, 166, 0, 29),
  (_seed_id('pre30'), _seed_id('vexpro-001'), 'Fotografo', 78, 78, 0, 30),
  (_seed_id('pre31'), _seed_id('vexpro-001'), 'Productos de marketing', 480, 480, 0, 31),
  (_seed_id('pre32'), _seed_id('vexpro-001'), 'Renta oficina Filipinas', 68, 68, 0, 32),
  (_seed_id('pre33'), _seed_id('vexpro-001'), 'Hospedaje Filipinas', 290, 290, 0, 33),
  (_seed_id('pre34'), _seed_id('vexpro-001'), 'Vuelos Filipinas (ida/vuelta)', 784, 784, 0, 34),
  (_seed_id('pre35'), _seed_id('vexpro-001'), 'Cambio Letreros oficina', 300, 300, 0, 35),
  (_seed_id('pre36'), _seed_id('vexpro-001'), 'Pago Director HK y Mauritius', 125, 125, 0, 36)
ON CONFLICT DO NOTHING;


-- ============================================================
-- 9. OPERATING INCOME (7 entries)
-- ============================================================
INSERT INTO operating_income (id, period_id, company_id, prop_firm, broker_pnl, other) VALUES
  (_seed_id('oi1'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 0, -3699, 0),
  (_seed_id('oi2'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 0, 60251, 0),
  (_seed_id('oi3'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 0, 135424.5, 0),
  (_seed_id('oi4'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 0, 0, 0),
  (_seed_id('oi5'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0, 0, 0),
  (_seed_id('oi6'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 0, 0, 0),
  (_seed_id('oi7'), _seed_id('p-apr-26'), _seed_id('vexpro-001'), 0, 0, 0)
ON CONFLICT DO NOTHING;


-- ============================================================
-- 10. BROKER BALANCE (7 entries)
-- ============================================================
INSERT INTO broker_balance (id, period_id, company_id, pnl_book_b, liquidity_commissions) VALUES
  (_seed_id('bb1'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), -3699, 0),
  (_seed_id('bb2'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 60474, 0),
  (_seed_id('bb3'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 135424.5, 0),
  (_seed_id('bb4'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 0, 0),
  (_seed_id('bb5'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0, 0),
  (_seed_id('bb6'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 0, 0),
  (_seed_id('bb7'), _seed_id('p-apr-26'), _seed_id('vexpro-001'), 0, 0)
ON CONFLICT DO NOTHING;


-- ============================================================
-- 11. FINANCIAL STATUS (7 entries)
-- ============================================================
INSERT INTO financial_status (id, period_id, company_id, operating_expenses_paid, net_total, previous_month_balance, current_month_balance) VALUES
  (_seed_id('fs1'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 35797.89, -31744.682, 0, 16466.45),
  (_seed_id('fs2'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 64632.7, -8040.83, 16466.45, 173080.85),
  (_seed_id('fs3'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 57161.85, -30272.525, 173080.85, 165148.41),
  (_seed_id('fs4'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 51129.47, -36934.97, 165148.41, -132839.64),
  (_seed_id('fs5'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 64625.6, -41773.1875, -132839.64, -30753.63),
  (_seed_id('fs6'), _seed_id('p-mar-26'), _seed_id('vexpro-001'), 67252, -57252, -30753.63, -44585.35),
  (_seed_id('fs7'), _seed_id('p-apr-26'), _seed_id('vexpro-001'), 0, 0, -44585.35, -44585.35)
ON CONFLICT DO NOTHING;


-- ============================================================
-- 12. PARTNERS (4 entries)
-- ============================================================
INSERT INTO partners (id, company_id, user_id, name, email, percentage) VALUES
  (_seed_id('partner1'), _seed_id('vexpro-001'), NULL, 'Sergio', NULL, 0.25),
  (_seed_id('partner2'), _seed_id('vexpro-001'), NULL, 'Hugo', NULL, 0.30),
  (_seed_id('partner3'), _seed_id('vexpro-001'), NULL, 'Kevin', NULL, 0.30),
  (_seed_id('partner4'), _seed_id('vexpro-001'), NULL, 'Stiven', NULL, 0.15)
ON CONFLICT DO NOTHING;


-- ============================================================
-- 13. PARTNER DISTRIBUTIONS (28 entries)
-- ============================================================
INSERT INTO partner_distributions (id, period_id, partner_id, company_id, percentage, amount) VALUES
  -- Oct 25
  (_seed_id('pd1'), _seed_id('p-oct-25'), _seed_id('partner1'), _seed_id('vexpro-001'), 0.25, 119.05),
  (_seed_id('pd2'), _seed_id('p-oct-25'), _seed_id('partner2'), _seed_id('vexpro-001'), 0.30, 142.86),
  (_seed_id('pd3'), _seed_id('p-oct-25'), _seed_id('partner3'), _seed_id('vexpro-001'), 0.30, 142.86),
  (_seed_id('pd4'), _seed_id('p-oct-25'), _seed_id('partner4'), _seed_id('vexpro-001'), 0.15, 71.43),
  -- Nov 25
  (_seed_id('pd5'), _seed_id('p-nov-25'), _seed_id('partner1'), _seed_id('vexpro-001'), 0.25, -2010.21),
  (_seed_id('pd6'), _seed_id('p-nov-25'), _seed_id('partner2'), _seed_id('vexpro-001'), 0.30, -2412.25),
  (_seed_id('pd7'), _seed_id('p-nov-25'), _seed_id('partner3'), _seed_id('vexpro-001'), 0.30, -2412.25),
  (_seed_id('pd8'), _seed_id('p-nov-25'), _seed_id('partner4'), _seed_id('vexpro-001'), 0.15, -1206.12),
  -- Dic 25
  (_seed_id('pd9'), _seed_id('p-dic-25'), _seed_id('partner1'), _seed_id('vexpro-001'), 0.25, 16128.86),
  (_seed_id('pd10'), _seed_id('p-dic-25'), _seed_id('partner2'), _seed_id('vexpro-001'), 0.30, 19354.63),
  (_seed_id('pd11'), _seed_id('p-dic-25'), _seed_id('partner3'), _seed_id('vexpro-001'), 0.30, 19354.63),
  (_seed_id('pd12'), _seed_id('p-dic-25'), _seed_id('partner4'), _seed_id('vexpro-001'), 0.15, 9677.32),
  -- Jan 26
  (_seed_id('pd13'), _seed_id('p-jan-26'), _seed_id('partner1'), _seed_id('vexpro-001'), 0.25, 3145.88),
  (_seed_id('pd14'), _seed_id('p-jan-26'), _seed_id('partner2'), _seed_id('vexpro-001'), 0.30, 3775.05),
  (_seed_id('pd15'), _seed_id('p-jan-26'), _seed_id('partner3'), _seed_id('vexpro-001'), 0.30, 3775.05),
  (_seed_id('pd16'), _seed_id('p-jan-26'), _seed_id('partner4'), _seed_id('vexpro-001'), 0.15, 1887.53),
  -- Feb 26
  (_seed_id('pd17'), _seed_id('p-feb-26'), _seed_id('partner1'), _seed_id('vexpro-001'), 0.25, 9639.31),
  (_seed_id('pd18'), _seed_id('p-feb-26'), _seed_id('partner2'), _seed_id('vexpro-001'), 0.30, 11567.17),
  (_seed_id('pd19'), _seed_id('p-feb-26'), _seed_id('partner3'), _seed_id('vexpro-001'), 0.30, 11567.17),
  (_seed_id('pd20'), _seed_id('p-feb-26'), _seed_id('partner4'), _seed_id('vexpro-001'), 0.15, 5783.59),
  -- Mar 26
  (_seed_id('pd21'), _seed_id('p-mar-26'), _seed_id('partner1'), _seed_id('vexpro-001'), 0.25, 0),
  (_seed_id('pd22'), _seed_id('p-mar-26'), _seed_id('partner2'), _seed_id('vexpro-001'), 0.30, 0),
  (_seed_id('pd23'), _seed_id('p-mar-26'), _seed_id('partner3'), _seed_id('vexpro-001'), 0.30, 0),
  (_seed_id('pd24'), _seed_id('p-mar-26'), _seed_id('partner4'), _seed_id('vexpro-001'), 0.15, 0),
  -- Apr 26
  (_seed_id('pd25'), _seed_id('p-apr-26'), _seed_id('partner1'), _seed_id('vexpro-001'), 0.25, 0),
  (_seed_id('pd26'), _seed_id('p-apr-26'), _seed_id('partner2'), _seed_id('vexpro-001'), 0.30, 0),
  (_seed_id('pd27'), _seed_id('p-apr-26'), _seed_id('partner3'), _seed_id('vexpro-001'), 0.30, 0),
  (_seed_id('pd28'), _seed_id('p-apr-26'), _seed_id('partner4'), _seed_id('vexpro-001'), 0.15, 0)
ON CONFLICT DO NOTHING;


-- ============================================================
-- 14. LIQUIDITY MOVEMENTS (24 entries)
-- ============================================================
INSERT INTO liquidity_movements (id, company_id, date, user_email, mt_account, deposit, withdrawal, balance, notes) VALUES
  (_seed_id('liq1'), _seed_id('vexpro-001'), '2025-11-11', 'desarrollohumano1287@gmail.com', '100742', 28000, 0, 28000, NULL),
  (_seed_id('liq2'), _seed_id('vexpro-001'), '2025-11-19', 'jme.inversiones.trading@gmail.com', '103111', 25000, 0, 53000, NULL),
  (_seed_id('liq3'), _seed_id('vexpro-001'), '2025-11-25', 'jme.inversiones.trading@gmail.com', '103111', 12500, 0, 65500, NULL),
  (_seed_id('liq4'), _seed_id('vexpro-001'), '2025-12-11', 'jme.inversiones.trading@gmail.com', '103111', 12236, 0, 77736, NULL),
  (_seed_id('liq5'), _seed_id('vexpro-001'), '2025-12-13', 'jme.inversiones.trading@gmail.com', '103111', 50000, 0, 127736, NULL),
  (_seed_id('liq6'), _seed_id('vexpro-001'), '2025-12-15', 'jme.inversiones.trading@gmail.com', '103111', 10000, 0, 137736, NULL),
  (_seed_id('liq7'), _seed_id('vexpro-001'), '2025-12-18', 'jme.inversiones.trading@gmail.com', '103111', 0, 25000, 112736, NULL),
  (_seed_id('liq8'), _seed_id('vexpro-001'), '2026-01-08', 'jme.inversiones.trading@gmail.com', '103111', 0, 13192, 99544, NULL),
  (_seed_id('liq9'), _seed_id('vexpro-001'), '2026-01-16', 'jme.inversiones.trading@gmail.com', NULL, 0, 16500, 83044, NULL),
  (_seed_id('liq10'), _seed_id('vexpro-001'), '2026-01-20', 'jme.inversiones.trading@gmail.com', NULL, 0, 23400, 59644, NULL),
  (_seed_id('liq11'), _seed_id('vexpro-001'), '2026-01-20', 'Perdidas Totales', NULL, 0, 59644, 0, 'Perdidas Totales'),
  (_seed_id('liq12'), _seed_id('vexpro-001'), '2026-03-06', 'zurita3103@gmail.com', NULL, 2508, 0, 2508, NULL),
  (_seed_id('liq13'), _seed_id('vexpro-001'), '2026-03-06', 'guillermo.soto1908@gmail.com', NULL, 850, 0, 3358, NULL),
  (_seed_id('liq14'), _seed_id('vexpro-001'), '2026-03-06', 'freddy_mejiaos10@outlook.com', NULL, 12186, 0, 15544, NULL),
  (_seed_id('liq15'), _seed_id('vexpro-001'), '2026-03-10', 'zurita3103@gmail.com', NULL, 2000, 0, 17544, NULL),
  (_seed_id('liq16'), _seed_id('vexpro-001'), '2026-03-10', 'carlosbolanos309@gmail.com', NULL, 3278, 0, 20822, NULL),
  (_seed_id('liq17'), _seed_id('vexpro-001'), '2026-03-13', 'e.ruelas.va@gmail.com', NULL, 2024, 0, 22846, NULL),
  (_seed_id('liq18'), _seed_id('vexpro-001'), '2026-03-13', 'javier.zurita@vexprofx.com', NULL, 3129.35, 0, 25975.35, NULL),
  (_seed_id('liq19'), _seed_id('vexpro-001'), '2026-03-16', 'movinglosalamos@gmail.com', NULL, 1073.02, 0, 27048.37, NULL),
  (_seed_id('liq20'), _seed_id('vexpro-001'), '2026-03-20', 'dani2121lopez@gmail.com', NULL, 1729.88, 0, 28778.25, NULL),
  (_seed_id('liq21'), _seed_id('vexpro-001'), '2026-03-20', 'zuritaedinzon01@gmail.com', NULL, 1773.36, 0, 30551.61, NULL),
  (_seed_id('liq22'), _seed_id('vexpro-001'), '2026-03-20', 'hugo.rodriguez.salgado@gmail.com', NULL, 1890.31, 0, 32441.92, NULL),
  (_seed_id('liq23'), _seed_id('vexpro-001'), '2026-03-20', 'k10perezvanegas@gmail.com', NULL, 1969.88, 0, 34411.80, NULL),
  (_seed_id('liq24'), _seed_id('vexpro-001'), '2026-03-20', 'pidollareun@gmail.com', NULL, 5000, 0, 39411.80, NULL)
ON CONFLICT DO NOTHING;


-- ============================================================
-- 15. INVESTMENTS (12 entries)
-- ============================================================
INSERT INTO investments (id, company_id, date, concept, responsible, deposit, withdrawal, profit, balance) VALUES
  (_seed_id('inv1'), _seed_id('vexpro-001'), '2025-12-18', 'Inversion OTC', 'Kevin', 90000, 0, 0, 90000),
  (_seed_id('inv2'), _seed_id('vexpro-001'), '2026-01-07', NULL, NULL, 0, 22579, 0, 67421),
  (_seed_id('inv3'), _seed_id('vexpro-001'), '2026-01-12', 'Profit OTC', NULL, 0, 0, 2700, 70121),
  (_seed_id('inv4'), _seed_id('vexpro-001'), '2026-01-13', 'Transferencia para procesar retiros', NULL, 0, 30000, 0, 40121),
  (_seed_id('inv5'), _seed_id('vexpro-001'), '2026-01-15', 'Transferencia para procesar retiros', NULL, 0, 20000, 0, 20121),
  (_seed_id('inv6'), _seed_id('vexpro-001'), '2026-01-16', 'Transferencia para procesar retiros', NULL, 0, 20121, 0, 0),
  (_seed_id('inv7'), _seed_id('vexpro-001'), '2026-03-10', 'Inversion ORO RETORNO', 'Kevin', 42000, 0, 0, 42000),
  (_seed_id('inv8'), _seed_id('vexpro-001'), '2026-03-12', 'Inversion ORO RETORNO', 'Kevin', 20000, 0, 0, 62000),
  (_seed_id('inv9'), _seed_id('vexpro-001'), '2026-03-25', 'Ganancia 5% inversion oro', 'Kevin', 2900, 0, 0, 64900),
  (_seed_id('inv10'), _seed_id('vexpro-001'), '2026-03-25', 'Inversion ORO RETORNO', 'Kevin', 17500, 0, 0, 82400),
  (_seed_id('inv11'), _seed_id('vexpro-001'), '2026-03-29', 'Inversion ORO RETORNO', 'Sergio', 150000, 0, 0, 232400),
  (_seed_id('inv12'), _seed_id('vexpro-001'), '2026-04-01', 'Inversion ORO RETORNO', 'Kevin', 30000, 0, 0, 262400)
ON CONFLICT DO NOTHING;


-- ============================================================
-- 16. EMPLOYEES (2 entries)
-- ============================================================
INSERT INTO employees (id, company_id, name, email, position, department, start_date, salary, status) VALUES
  (_seed_id('emp-001'), _seed_id('vexpro-001'), 'Kevin', 'kevin@vexprofx.com', 'CEO', 'Direccion', '2024-01-01', NULL, 'active'),
  (_seed_id('emp-002'), _seed_id('vexpro-001'), 'Daniela', 'daniela@vexprofx.com', 'Contadora', 'Finanzas', '2024-03-01', 800, 'active')
ON CONFLICT DO NOTHING;


-- ============================================================
-- 17. COMMERCIAL PROFILES (33 entries)
-- ============================================================
-- HEADs (no head_id)
INSERT INTO commercial_profiles (id, company_id, name, email, role, head_id, net_deposit_pct, pnl_pct, commission_per_lot, salary, benefits, comments, hire_date, birthday, status) VALUES
  (_seed_id('cp-001'), _seed_id('vexpro-001'), 'Hugo Ortiz', 'huguitoo.95@gmail.com', 'sales_manager', NULL, 7, NULL, NULL, NULL, NULL, 'Top earner. Variable salary in some months.', NULL, NULL, 'active'),
  (_seed_id('cp-002'), _seed_id('vexpro-001'), 'Andres Arciniegas', 'afarciniegas@gmail.com', 'head', NULL, 7, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active'),
  (_seed_id('cp-003'), _seed_id('vexpro-001'), 'Luka Angeles', 'lukaangeles@gmail.com', 'head', NULL, 7, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active'),
  (_seed_id('cp-004'), _seed_id('vexpro-001'), 'Luis Diaz', 'luismigueldiazortega@gmail.com', 'head', NULL, 7, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active'),
  (_seed_id('cp-005'), _seed_id('vexpro-001'), 'Nicolas Garzaro', 'nicolasgarzaro@gmail.com', 'head', NULL, 7, NULL, NULL, NULL, NULL, 'Promoted from BDM to HEAD.', NULL, NULL, 'active')
ON CONFLICT DO NOTHING;

-- BDMs under Hugo Ortiz (cp-001)
INSERT INTO commercial_profiles (id, company_id, name, email, role, head_id, net_deposit_pct, pnl_pct, commission_per_lot, salary, benefits, comments, hire_date, birthday, status) VALUES
  (_seed_id('cp-006'), _seed_id('vexpro-001'), 'Javier Castillo', 'javiercastillofx@gmail.com', 'bdm', _seed_id('cp-001'), 4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active'),
  (_seed_id('cp-007'), _seed_id('vexpro-001'), 'Angie Tapia', 'tpangietapia@gmail.com', 'bdm', _seed_id('cp-001'), 4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active'),
  (_seed_id('cp-008'), _seed_id('vexpro-001'), 'Aldo Vital', 'aldovital@gmail.com', 'bdm', _seed_id('cp-001'), 4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active'),
  (_seed_id('cp-009'), _seed_id('vexpro-001'), 'Jeff Alfonso', 'jeffalfonsoskt8@gmail.com', 'bdm', _seed_id('cp-001'), 4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active'),
  (_seed_id('cp-010'), _seed_id('vexpro-001'), 'Christian Prada', 'christianpradaoficial@gmail.com', 'bdm', _seed_id('cp-001'), 4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active'),
  (_seed_id('cp-011'), _seed_id('vexpro-001'), 'Zeidy Riano', 'zeidyriano@gmail.com', 'bdm', _seed_id('cp-001'), 4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active'),
  (_seed_id('cp-012'), _seed_id('vexpro-001'), 'Javier Zurita', 'zuritajavier6@gmail.com', 'bdm', _seed_id('cp-001'), 4, NULL, NULL, 500, NULL, 'Fixed salary in Nov 2024.', NULL, NULL, 'active'),
  (_seed_id('cp-013'), _seed_id('vexpro-001'), 'Jefry Orozco', 'orozcotrading7@gmail.com', 'bdm', _seed_id('cp-001'), 4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active'),
  (_seed_id('cp-014'), _seed_id('vexpro-001'), 'Mario Sanchez', 'mariosnchz33@gmail.com', 'bdm', _seed_id('cp-001'), 4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active'),
  (_seed_id('cp-015'), _seed_id('vexpro-001'), 'Jose Elizalde', 'eliaselizalde11@gmail.com', 'bdm', _seed_id('cp-001'), 4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active'),
  (_seed_id('cp-016'), _seed_id('vexpro-001'), 'Antony Flores', 'tonnyutreras@gmail.com', 'bdm', _seed_id('cp-001'), 4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active')
ON CONFLICT DO NOTHING;

-- BDMs under Andres Arciniegas (cp-002)
INSERT INTO commercial_profiles (id, company_id, name, email, role, head_id, net_deposit_pct, pnl_pct, commission_per_lot, salary, benefits, comments, hire_date, birthday, status) VALUES
  (_seed_id('cp-017'), _seed_id('vexpro-001'), 'Luis Montalban', 'luismontalbanfx@gmail.com', 'bdm', _seed_id('cp-002'), 4, NULL, NULL, 500, NULL, 'Fixed salary in Dec 2024.', NULL, NULL, 'active'),
  (_seed_id('cp-018'), _seed_id('vexpro-001'), 'Christian Arellano', 'christianarellanofx@gmail.com', 'bdm', _seed_id('cp-002'), 4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active')
ON CONFLICT DO NOTHING;

-- BDMs under Luka Angeles (cp-003)
INSERT INTO commercial_profiles (id, company_id, name, email, role, head_id, net_deposit_pct, pnl_pct, commission_per_lot, salary, benefits, comments, hire_date, birthday, status) VALUES
  (_seed_id('cp-019'), _seed_id('vexpro-001'), 'Ana Garcia', 'garciaana4531@gmail.com', 'bdm', _seed_id('cp-003'), 4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active'),
  (_seed_id('cp-020'), _seed_id('vexpro-001'), 'Omar Sosa', 'omarsosa.fx@gmail.com', 'bdm', _seed_id('cp-003'), 4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active')
ON CONFLICT DO NOTHING;

-- BDMs under Luis Diaz (cp-004)
INSERT INTO commercial_profiles (id, company_id, name, email, role, head_id, net_deposit_pct, pnl_pct, commission_per_lot, salary, benefits, comments, hire_date, birthday, status) VALUES
  (_seed_id('cp-021'), _seed_id('vexpro-001'), 'Jose Bozua', 'josebozua@gmail.com', 'bdm', _seed_id('cp-004'), 4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active'),
  (_seed_id('cp-022'), _seed_id('vexpro-001'), 'Juan Hernandez', 'juancamilohernandez08@gmail.com', 'bdm', _seed_id('cp-004'), 4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active'),
  (_seed_id('cp-023'), _seed_id('vexpro-001'), 'Eladio Garfias', 'eladiogarfiasfx@gmail.com', 'bdm', _seed_id('cp-004'), 4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active'),
  (_seed_id('cp-024'), _seed_id('vexpro-001'), 'German Bolivar', 'germanbolivar81@gmail.com', 'bdm', _seed_id('cp-004'), 4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active')
ON CONFLICT DO NOTHING;

-- BDMs under Nicolas Garzaro (cp-005)
INSERT INTO commercial_profiles (id, company_id, name, email, role, head_id, net_deposit_pct, pnl_pct, commission_per_lot, salary, benefits, comments, hire_date, birthday, status) VALUES
  (_seed_id('cp-025'), _seed_id('vexpro-001'), 'Andres Serrano', 'andresserranofx@gmail.com', 'bdm', _seed_id('cp-005'), 4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active'),
  (_seed_id('cp-026'), _seed_id('vexpro-001'), 'Rafael Martinez', 'rafaelmartinezlatam@gmail.com', 'bdm', _seed_id('cp-005'), 4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active')
ON CONFLICT DO NOTHING;

-- Independent BDMs (no head)
INSERT INTO commercial_profiles (id, company_id, name, email, role, head_id, net_deposit_pct, pnl_pct, commission_per_lot, salary, benefits, comments, hire_date, birthday, status) VALUES
  (_seed_id('cp-027'), _seed_id('vexpro-001'), 'Ali Germenos', 'aligermenos15@gmail.com', 'bdm', NULL, 4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active'),
  (_seed_id('cp-028'), _seed_id('vexpro-001'), 'Nicolas Raffo', 'nicolasraffo@gmail.com', 'bdm', NULL, NULL, NULL, NULL, 2000, NULL, 'Fixed salary $2,000/month.', NULL, NULL, 'active'),
  (_seed_id('cp-029'), _seed_id('vexpro-001'), 'Tonny Valencia', 'tonnyvalencia@gmail.com', 'bdm', NULL, 4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active'),
  (_seed_id('cp-030'), _seed_id('vexpro-001'), 'Lynette Cushcagua', 'lynettecushcagua@gmail.com', 'bdm', NULL, 4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active'),
  (_seed_id('cp-031'), _seed_id('vexpro-001'), 'Johana Rangel', 'johanarangel@gmail.com', 'bdm', NULL, 4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active'),
  (_seed_id('cp-032'), _seed_id('vexpro-001'), 'Stephan Tible', 'stephantible@gmail.com', 'bdm', NULL, NULL, NULL, NULL, 1500, NULL, 'Fixed salary $1,500/month.', NULL, NULL, 'active'),
  -- PNL-based profile
  (_seed_id('cp-033'), _seed_id('vexpro-001'), 'Millones693', 'millones693@gmail.com', 'bdm', NULL, NULL, 20, NULL, NULL, NULL, '20% of PNL. Special arrangement.', NULL, NULL, 'active')
ON CONFLICT DO NOTHING;


-- ============================================================
-- 18. COMMERCIAL MONTHLY RESULTS (94 entries)
-- mr(id, profileId, periodId, current, accumulated, total, pnl, commissions, bonus, salary)
-- total_earned = commissions + bonus + salary
-- ============================================================
INSERT INTO commercial_monthly_results (id, profile_id, period_id, company_id, net_deposit_current, net_deposit_accumulated, net_deposit_total, pnl_current, pnl_accumulated, pnl_total, commissions_earned, bonus, salary_paid, total_earned) VALUES
  -- Hugo Ortiz (cp-001)
  (_seed_id('mr-001'), _seed_id('cp-001'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  (_seed_id('mr-002'), _seed_id('cp-001'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 2000, 2000),
  (_seed_id('mr-003'), _seed_id('cp-001'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 1000, 1000),
  (_seed_id('mr-004'), _seed_id('cp-001'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 117950, 0, 117950, 0, 0, 0, 8256.50, 0, 0, 8256.50),
  (_seed_id('mr-005'), _seed_id('cp-001'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 79350, 58975, 138325, 0, 0, 0, 12921.19, 0, 0, 12921.19),
  -- Andres Arciniegas (cp-002)
  (_seed_id('mr-006'), _seed_id('cp-002'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  (_seed_id('mr-007'), _seed_id('cp-002'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  (_seed_id('mr-008'), _seed_id('cp-002'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 18400, 0, 18400, 0, 0, 0, 1288.00, 0, 0, 1288.00),
  (_seed_id('mr-009'), _seed_id('cp-002'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 3800, 9200, 13000, 0, 0, 0, 358.46, 0, 0, 358.46),
  (_seed_id('mr-010'), _seed_id('cp-002'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 3000, 5900, 8900, 0, 0, 0, 840.00, 0, 0, 840.00),
  -- Luka Angeles (cp-003)
  (_seed_id('mr-011'), _seed_id('cp-003'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  (_seed_id('mr-012'), _seed_id('cp-003'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 1000, 1000),
  (_seed_id('mr-013'), _seed_id('cp-003'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 14500, 0, 14500, 0, 0, 0, 1015.00, 0, 0, 1015.00),
  (_seed_id('mr-014'), _seed_id('cp-003'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 12700, 7250, 19950, 0, 0, 0, 1305.96, 0, 0, 1305.96),
  (_seed_id('mr-015'), _seed_id('cp-003'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  -- Luis Diaz (cp-004)
  (_seed_id('mr-016'), _seed_id('cp-004'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  (_seed_id('mr-017'), _seed_id('cp-004'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 750, 750),
  (_seed_id('mr-018'), _seed_id('cp-004'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 11700, 0, 11700, 0, 0, 0, 819.00, 0, 0, 819.00),
  (_seed_id('mr-019'), _seed_id('cp-004'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 28200, 5850, 34050, 0, 0, 0, 2265.42, 0, 0, 2265.42),
  (_seed_id('mr-020'), _seed_id('cp-004'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  -- Nicolas Garzaro (cp-005)
  (_seed_id('mr-021'), _seed_id('cp-005'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  (_seed_id('mr-022'), _seed_id('cp-005'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  (_seed_id('mr-023'), _seed_id('cp-005'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  (_seed_id('mr-024'), _seed_id('cp-005'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  (_seed_id('mr-025'), _seed_id('cp-005'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 2000, 0, 2000, 0, 0, 0, 140.00, 0, 0, 140.00),
  -- Javier Castillo (cp-006)
  (_seed_id('mr-026'), _seed_id('cp-006'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  (_seed_id('mr-027'), _seed_id('cp-006'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  (_seed_id('mr-028'), _seed_id('cp-006'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  (_seed_id('mr-029'), _seed_id('cp-006'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 11750, 0, 11750, 0, 0, 0, 470.00, 0, 0, 470.00),
  (_seed_id('mr-030'), _seed_id('cp-006'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 600, 5875, 6475, 0, 0, 0, 259.00, 0, 0, 259.00),
  -- Angie Tapia (cp-007)
  (_seed_id('mr-031'), _seed_id('cp-007'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 2000, 0, 2000, 0, 0, 0, 80.00, 0, 0, 80.00),
  (_seed_id('mr-032'), _seed_id('cp-007'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0, 1000, 1000, 0, 0, 0, 40.00, 0, 0, 40.00),
  -- Aldo Vital (cp-008)
  (_seed_id('mr-033'), _seed_id('cp-008'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 2500, 0, 2500, 0, 0, 0, 100.00, 0, 0, 100.00),
  (_seed_id('mr-034'), _seed_id('cp-008'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 5800, 1250, 7050, 0, 0, 0, 282.00, 0, 0, 282.00),
  -- Jeff Alfonso (cp-009)
  (_seed_id('mr-035'), _seed_id('cp-009'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 5000, 0, 5000, 0, 0, 0, 200.00, 0, 0, 200.00),
  (_seed_id('mr-036'), _seed_id('cp-009'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0, 2500, 2500, 0, 0, 0, 100.00, 0, 0, 100.00),
  -- Christian Prada (cp-010)
  (_seed_id('mr-037'), _seed_id('cp-010'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 2000, 0, 2000, 0, 0, 0, 80.00, 0, 0, 80.00),
  (_seed_id('mr-038'), _seed_id('cp-010'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0, 1000, 1000, 0, 0, 0, 40.00, 0, 0, 40.00),
  -- Zeidy Riano (cp-011)
  (_seed_id('mr-039'), _seed_id('cp-011'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 6600, 0, 6600, 0, 0, 0, 264.00, 0, 0, 264.00),
  (_seed_id('mr-040'), _seed_id('cp-011'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 11900, 3300, 15200, 0, 0, 0, 608.00, 0, 0, 608.00),
  -- Javier Zurita (cp-012)
  (_seed_id('mr-041'), _seed_id('cp-012'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 500, 500),
  (_seed_id('mr-042'), _seed_id('cp-012'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 7500, 0, 7500, 0, 0, 0, 300.00, 0, 0, 300.00),
  (_seed_id('mr-043'), _seed_id('cp-012'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 3100, 3750, 6850, 0, 0, 0, 274.00, 0, 0, 274.00),
  -- Jefry Orozco (cp-013)
  (_seed_id('mr-044'), _seed_id('cp-013'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 5500, 0, 5500, 0, 0, 0, 220.00, 0, 0, 220.00),
  (_seed_id('mr-045'), _seed_id('cp-013'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0, 2750, 2750, 0, 0, 0, 110.00, 0, 0, 110.00),
  -- Mario Sanchez (cp-014)
  (_seed_id('mr-046'), _seed_id('cp-014'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 6750, 0, 6750, 0, 0, 0, 270.00, 0, 0, 270.00),
  (_seed_id('mr-047'), _seed_id('cp-014'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0, 3375, 3375, 0, 0, 0, 135.00, 0, 0, 135.00),
  -- Jose Elizalde (cp-015)
  (_seed_id('mr-048'), _seed_id('cp-015'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 11750, 0, 11750, 0, 0, 0, 470.00, 0, 0, 470.00),
  (_seed_id('mr-049'), _seed_id('cp-015'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 8650, 5875, 14525, 0, 0, 0, 581.00, 0, 0, 581.00),
  -- Antony Flores (cp-016)
  (_seed_id('mr-050'), _seed_id('cp-016'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 2000, 0, 2000, 0, 0, 0, 80.00, 0, 0, 80.00),
  -- Luis Montalban (cp-017)
  (_seed_id('mr-051'), _seed_id('cp-017'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 500, 500),
  (_seed_id('mr-052'), _seed_id('cp-017'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 3800, 0, 3800, 0, 0, 0, 152.00, 0, 0, 152.00),
  (_seed_id('mr-053'), _seed_id('cp-017'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 3000, 1900, 4900, 0, 0, 0, 196.00, 0, 0, 196.00),
  -- Christian Arellano (cp-018)
  (_seed_id('mr-054'), _seed_id('cp-018'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 18400, 0, 18400, 0, 0, 0, 736.00, 0, 0, 736.00),
  (_seed_id('mr-055'), _seed_id('cp-018'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 0, 9200, 9200, 0, 0, 0, 368.00, 0, 0, 368.00),
  (_seed_id('mr-056'), _seed_id('cp-018'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  -- Ana Garcia (cp-019)
  (_seed_id('mr-057'), _seed_id('cp-019'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 6000, 0, 6000, 0, 0, 0, 240.00, 0, 0, 240.00),
  (_seed_id('mr-058'), _seed_id('cp-019'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 10200, 3000, 13200, 0, 0, 0, 528.00, 0, 0, 528.00),
  (_seed_id('mr-059'), _seed_id('cp-019'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  -- Omar Sosa (cp-020)
  (_seed_id('mr-060'), _seed_id('cp-020'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 8500, 0, 8500, 0, 0, 0, 340.00, 0, 0, 340.00),
  (_seed_id('mr-061'), _seed_id('cp-020'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 2500, 4250, 6750, 0, 0, 0, 270.00, 0, 0, 270.00),
  (_seed_id('mr-062'), _seed_id('cp-020'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  -- Jose Bozua (cp-021)
  (_seed_id('mr-063'), _seed_id('cp-021'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 6500, 0, 6500, 0, 0, 0, 260.00, 0, 0, 260.00),
  (_seed_id('mr-064'), _seed_id('cp-021'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 13700, 3250, 16950, 0, 0, 0, 678.00, 0, 0, 678.00),
  (_seed_id('mr-065'), _seed_id('cp-021'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  -- Juan Hernandez (cp-022)
  (_seed_id('mr-066'), _seed_id('cp-022'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 1200, 0, 1200, 0, 0, 0, 48.00, 0, 0, 48.00),
  (_seed_id('mr-067'), _seed_id('cp-022'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 9000, 600, 9600, 0, 0, 0, 384.00, 0, 0, 384.00),
  (_seed_id('mr-068'), _seed_id('cp-022'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  -- Eladio Garfias (cp-023)
  (_seed_id('mr-069'), _seed_id('cp-023'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 4000, 0, 4000, 0, 0, 0, 160.00, 0, 0, 160.00),
  (_seed_id('mr-070'), _seed_id('cp-023'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 5500, 2000, 7500, 0, 0, 0, 300.00, 0, 0, 300.00),
  (_seed_id('mr-071'), _seed_id('cp-023'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  -- German Bolivar (cp-024)
  (_seed_id('mr-072'), _seed_id('cp-024'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  (_seed_id('mr-073'), _seed_id('cp-024'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  -- Andres Serrano (cp-025)
  (_seed_id('mr-074'), _seed_id('cp-025'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 2000, 0, 2000, 0, 0, 0, 80.00, 0, 0, 80.00),
  -- Rafael Martinez (cp-026)
  (_seed_id('mr-075'), _seed_id('cp-026'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  -- Ali Germenos (cp-027)
  (_seed_id('mr-076'), _seed_id('cp-027'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  -- Nicolas Raffo (cp-028) - Fixed salary
  (_seed_id('mr-077'), _seed_id('cp-028'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 2000, 2000),
  (_seed_id('mr-078'), _seed_id('cp-028'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 2000, 2000),
  (_seed_id('mr-079'), _seed_id('cp-028'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 2000, 2000),
  (_seed_id('mr-080'), _seed_id('cp-028'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 2000, 2000),
  (_seed_id('mr-081'), _seed_id('cp-028'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 2000, 2000),
  -- Tonny Valencia (cp-029)
  (_seed_id('mr-082'), _seed_id('cp-029'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  -- Lynette Cushcagua (cp-030)
  (_seed_id('mr-083'), _seed_id('cp-030'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  -- Johana Rangel (cp-031)
  (_seed_id('mr-084'), _seed_id('cp-031'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  -- Stephan Tible (cp-032) - Fixed salary
  (_seed_id('mr-085'), _seed_id('cp-032'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 1500, 1500),
  (_seed_id('mr-086'), _seed_id('cp-032'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 1500, 1500),
  (_seed_id('mr-087'), _seed_id('cp-032'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 1500, 1500),
  (_seed_id('mr-088'), _seed_id('cp-032'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 1500, 1500),
  (_seed_id('mr-089'), _seed_id('cp-032'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 1500, 1500),
  -- Millones693 PNL (cp-033)
  (_seed_id('mr-090'), _seed_id('cp-033'), _seed_id('p-oct-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  (_seed_id('mr-091'), _seed_id('cp-033'), _seed_id('p-nov-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  (_seed_id('mr-092'), _seed_id('cp-033'), _seed_id('p-dic-25'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  (_seed_id('mr-093'), _seed_id('cp-033'), _seed_id('p-jan-26'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  (_seed_id('mr-094'), _seed_id('cp-033'), _seed_id('p-feb-26'), _seed_id('vexpro-001'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
ON CONFLICT DO NOTHING;


-- ============================================================
-- Cleanup: drop the helper function
-- ============================================================
DROP FUNCTION IF EXISTS _seed_id(TEXT);

COMMIT;

COMMIT;
