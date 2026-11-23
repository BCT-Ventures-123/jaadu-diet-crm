-- Adds the 'aman' role (Aman CRM + call-centre CRM, no admin/reports) and moves the existing 'aman' login onto it.
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_role_check;
ALTER TABLE agents ADD CONSTRAINT agents_role_check CHECK (role IN ('admin', 'agent', 'aman'));
UPDATE agents SET role = 'aman' WHERE username = 'aman' AND role = 'agent';
