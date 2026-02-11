INSERT INTO settings(key,value,updated_at) VALUES
('BASE_FARE','3.50',NOW()),
('FREE_KM','3',NOW()),
('PER_KM','0.40',NOW()),
('COMMISSION_RATE','0.10',NOW()),
('MIN_DRIVER_BALANCE','-10',NOW())
ON CONFLICT (key) DO NOTHING;
