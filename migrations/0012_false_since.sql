-- When a network was first found false: marking it again renews how long it lasts, not what counted before.
ALTER TABLE false_reporters ADD COLUMN since INTEGER;
