-- Which container a forward points at. Rows cascade with the gateway; the
-- Traefik file is removed by removeGateway() before the row goes.
ALTER TABLE port_forwards ADD COLUMN gateway_id TEXT REFERENCES gateways(id) ON DELETE CASCADE;
