-- ==============================================================
-- Medix DDI Database Schema
-- Target Engine: Cloudflare D1 (Serverless SQLite at the Edge)
-- ==============================================================

-- Drop tables if resetting schema
DROP TABLE IF EXISTS interactions;
DROP TABLE IF EXISTS medicines;

-- Table 1: Commercial Medicines & Active Generic Compositions
-- Maps commercial brand trade names to their Active Pharmaceutical Ingredients (APIs)
CREATE TABLE medicines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_name TEXT NOT NULL,
    composition TEXT NOT NULL
);

-- Table 2: Drug-Drug Clinical Interactions
-- Stores verified pairwise interactions and clinical severity grades
CREATE TABLE interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drug1 TEXT NOT NULL,
    drug2 TEXT NOT NULL,
    severity TEXT NOT NULL -- 'High', 'Moderate', 'Minor' / 'Low'
);

-- ==============================================================
-- Performance Optimization Indexes
-- Ensures sub-millisecond B-Tree point lookups and range scans
-- ==============================================================

-- Index for instant brand name resolution & prefix search autocomplete (LIKE 'query%')
-- MUST use COLLATE NOCASE so SQLite executes a B-Tree range SEARCH instead of a 318k-row full table SCAN
CREATE INDEX idx_brand_name ON medicines(brand_name COLLATE NOCASE);

-- Composite covering index for pairwise interaction lookups
CREATE INDEX idx_interactions_drugs ON interactions(drug1, drug2);

