-- The first version whose reports can block it: an appeal that clears its owner moves it on (decision 146).
ALTER TABLE docs ADD COLUMN counts_from INTEGER NOT NULL DEFAULT 0;
