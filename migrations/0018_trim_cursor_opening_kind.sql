-- Where the sweep left off trimming replaced versions, so documents held as evidence cannot keep the rest waiting.
ALTER TABLE service_stage ADD COLUMN trim_after TEXT NOT NULL DEFAULT '';

-- What an opening read: the reported link, the reporter's email, or a case link. The reason is the operator's free text.
ALTER TABLE openings ADD COLUMN kind TEXT NOT NULL DEFAULT 'link';
UPDATE openings SET kind = 'case' WHERE reason LIKE 'case %';
UPDATE openings SET kind = 'contact' WHERE reason LIKE 'correo: %';
