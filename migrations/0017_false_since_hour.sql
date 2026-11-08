-- The hour it was first found false, so a report later that same day keeps nothing, and one before it still does.
ALTER TABLE false_reporters ADD COLUMN since_hour INTEGER;
