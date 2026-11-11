-- Who edited first wins a tie past the cap of what a reader is told, since roots made later cannot have arrived before.
ALTER TABLE editors ADD COLUMN first_version INTEGER;
-- The machine an editor last sent a version from is the likeliest to have signed their entry, so it leads their own.
ALTER TABLE editors ADD COLUMN machine TEXT;
-- Those here before take what their listed versions say, or 0; a row older code adds later, with none, goes last.
UPDATE editors SET
  first_version = COALESCE((
    SELECT MIN(json_extract(v.value, '$.n')) FROM docs d, json_each(d.versions) v
    WHERE d.id = editors.doc AND json_extract(v.value, '$.signer') = editors.root
  ), 0),
  machine = (
    SELECT json_extract(v.value, '$.machine') FROM docs d, json_each(d.versions) v
    WHERE d.id = editors.doc AND json_extract(v.value, '$.signer') = editors.root
    ORDER BY json_extract(v.value, '$.n') DESC LIMIT 1
  );
