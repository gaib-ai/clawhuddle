UPDATE port_forwards
SET gateway_id = (SELECT g.id FROM gateways g WHERE g.member_id = port_forwards.member_id AND g.slot = 1)
WHERE gateway_id IS NULL;
