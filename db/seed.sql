INSERT INTO products (sku,name) VALUES
 ('SKU-ALP-01','Alpine Trail Bottle'),('SKU-BLU-07','Blue Ridge Mug'),('SKU-CED-03','Cedar Camp Towel')
ON CONFLICT (sku) DO NOTHING;
INSERT INTO locations (code,capacity,sku) VALUES
 ('A-01-03',100,'SKU-ALP-01'),('B-02-01',60,'SKU-BLU-07'),('C-01-02',50,'SKU-CED-03')
ON CONFLICT (code) DO NOTHING;
INSERT INTO boxes (box_id,sku,quantity,received_at,status) VALUES
 ('BOX-1042','SKU-ALP-01',24,now(),'received'),('BOX-1043','SKU-BLU-07',12,now(),'received'),
 ('BOX-1044','SKU-ALP-01',18,now(),'received'),('BOX-1045','SKU-CED-03',8,now(),'received')
ON CONFLICT (box_id) DO NOTHING;
