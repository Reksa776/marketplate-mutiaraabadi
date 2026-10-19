-- ============================================================================
-- ORDER / TRANSACTION CLEANUP — READ-ONLY AUDIT BUNDLE
-- ============================================================================
-- 100% SELECT. No INSERT/UPDATE/DELETE/TRUNCATE/DROP/ALTER/CALL.
-- Safe to run against production.
--
-- Usage (never put the password on the command line):
--   mysql --defaults-extra-file=/root/.my.cnf -t <docs/ORDER-CLEANUP-AUDIT.sql
--   mysql --defaults-extra-file=/root/.my.cnf -t mutiara_db \
--         -e "source docs/ORDER-CLEANUP-AUDIT.sql"
--
-- Run section by section if you prefer; every block is independent.
-- ============================================================================

SELECT DATABASE() AS db, VERSION() AS server,
       @@global.foreign_key_checks AS fk_checks,
       @@global.sql_mode AS sql_mode;

-- ---------------------------------------------------------------------------
-- A. EVERY TABLE + EXACT ROW COUNT (generated one line per table)
-- ---------------------------------------------------------------------------
SELECT TABLE_NAME AS table_name, TABLE_TYPE AS type, ENGINE AS engine
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE()
 ORDER BY TABLE_NAME;

-- Exact counts (copy/paste the output of the previous query into this
-- generator, or just run the per-table counts the app script prints).
SELECT CONCAT(
         'SELECT ''', TABLE_NAME, ''' AS table_name, COUNT(*) AS rows FROM `',
         TABLE_NAME, '` UNION ALL '
       ) AS stmt
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
 ORDER BY TABLE_NAME;

-- ---------------------------------------------------------------------------
-- B. FOREIGN KEYS — ACTUAL ON DELETE RULES
-- ---------------------------------------------------------------------------
SELECT kcu.TABLE_NAME AS child_table,
       kcu.COLUMN_NAME AS child_col,
       kcu.REFERENCED_TABLE_NAME AS parent_table,
       kcu.REFERENCED_COLUMN_NAME AS parent_col,
       rc.DELETE_RULE AS on_delete,
       rc.UPDATE_RULE AS on_update
  FROM information_schema.KEY_COLUMN_USAGE kcu
  JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
    ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
   AND rc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
 WHERE kcu.TABLE_SCHEMA = DATABASE()
   AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
 ORDER BY kcu.TABLE_NAME, kcu.COLUMN_NAME;

-- ---------------------------------------------------------------------------
-- C. SCHEMA DRIFT: tables in the DB that the Prisma schema does not map,
--    and mapped tables the DB is missing. Compare with prisma/schema.prisma.
-- ---------------------------------------------------------------------------
SELECT TABLE_NAME AS db_table
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_TYPE = 'BASE TABLE'
   AND TABLE_NAME NOT IN (
       'user','account','session','verificationtoken','product','productvariant',
       'cart','cartitem','useraddress','order','orderitem','shipmentjob',
       'whatsapp_chat_state','whatsapp_inbound_message','storesetting','province',
       'regency','district','village','rajaongkirregion','voucher',
       'guestrecoverychallenge','notification','campaign','campaignproduct',
       'campaigncategory','productdiscount','flashsale','flashsalepurchase',
       'promotion','voucherproduct','vouchercategory','voucheruserusage',
       'bulkdiscount','shippingdiscount','broadcast','affiliateprofile',
       'affiliatekyc','affiliateclick','affiliateconversion','affiliatepayout',
       'adminauditlog','spinwheelcampaign','spinwheelreward','spinwheelspin',
       'refund','_prisma_migrations')
 ORDER BY TABLE_NAME;

SELECT migration_name, finished_at, rolled_back_at
  FROM _prisma_migrations
 ORDER BY started_at;

-- ---------------------------------------------------------------------------
-- D. TRIGGERS / EVENTS / ROUTINES (must be empty before a cleanup)
-- ---------------------------------------------------------------------------
SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION
  FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE();

SELECT EVENT_NAME, STATUS, INTERVAL_VALUE, INTERVAL_FIELD
  FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE();

SELECT ROUTINE_NAME, ROUTINE_TYPE
  FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE();

-- ---------------------------------------------------------------------------
-- E. ORDER STATE DISTRIBUTION
-- ---------------------------------------------------------------------------
SELECT status, paymentStatus, paymentMethod, COUNT(*) AS orders,
       SUM(total) AS total_value
  FROM `order`
 GROUP BY status, paymentStatus, paymentMethod
 ORDER BY orders DESC;

SELECT COUNT(*) AS orders_total,
       MIN(createdAt) AS first_order,
       MAX(createdAt) AS last_order,
       SUM(userId IS NULL) AS guest_orders,
       SUM(guestIdentityKey IS NOT NULL) AS guest_identity_rows
  FROM `order`;

-- ---------------------------------------------------------------------------
-- F. CATEGORY C — OPEN OBLIGATIONS (must be resolved manually)
-- ---------------------------------------------------------------------------
SELECT 'refund open' AS check_name, COUNT(*) AS rows_
  FROM refund WHERE status IN ('PENDING','PROCESSING')
UNION ALL
SELECT 'affiliate commission PENDING/APPROVED/PAID', COUNT(*)
  FROM affiliateconversion WHERE status IN ('PENDING','APPROVED','PAID')
UNION ALL
SELECT 'affiliate payout PENDING/PROCESSING', COUNT(*)
  FROM affiliatepayout WHERE status IN ('PENDING','PROCESSING')
UNION ALL
SELECT 'shipmentjob PENDING/PROCESSING', COUNT(*)
  FROM shipmentjob WHERE status IN ('PENDING','PROCESSING')
UNION ALL
SELECT 'orders with active shipmentStatus', COUNT(*)
  FROM `order`
 WHERE shipmentStatus IS NOT NULL
   AND shipmentStatus NOT IN ('DELIVERED','CANCELLED','RETURNED','NOT_CREATED')
UNION ALL
SELECT 'orders with providerShipmentId', COUNT(*)
  FROM `order` WHERE providerShipmentId IS NOT NULL
UNION ALL
SELECT 'COD unsettled', COUNT(*)
  FROM `order`
 WHERE paymentMethod='COD' AND status NOT IN ('COMPLETED','CANCELLED')
UNION ALL
SELECT 'PAID but not COMPLETED', COUNT(*)
  FROM `order`
 WHERE paymentStatus='PAID' AND status NOT IN ('COMPLETED','REFUND_PENDING')
UNION ALL
SELECT 'notifications linked to an order', COUNT(*)
  FROM notification WHERE orderId IS NOT NULL
UNION ALL
SELECT 'admin audit rows entityType=Order', COUNT(*)
  FROM adminauditlog WHERE entityType='Order';

-- The exact blocking orders (join these ids to the cleanup exclusion list).
SELECT o.id, o.orderNumber, o.status, o.paymentStatus, o.paymentMethod,
       (SELECT COUNT(*) FROM refund r
         WHERE r.orderId=o.id AND r.status IN ('PENDING','PROCESSING')) AS open_refunds,
       (SELECT COUNT(*) FROM affiliateconversion ac
         WHERE ac.orderId=o.id AND ac.status IN ('PENDING','APPROVED','PAID')) AS live_commissions,
       (SELECT COUNT(*) FROM shipmentjob sj
         WHERE sj.orderId=o.id AND sj.status IN ('PENDING','PROCESSING')) AS active_jobs,
       o.shipmentStatus, o.providerShipmentId
  FROM `order` o
 WHERE EXISTS (SELECT 1 FROM refund r
                WHERE r.orderId=o.id AND r.status IN ('PENDING','PROCESSING'))
    OR EXISTS (SELECT 1 FROM affiliateconversion ac
                WHERE ac.orderId=o.id AND ac.status IN ('PENDING','APPROVED','PAID'))
    OR EXISTS (SELECT 1 FROM shipmentjob sj
                WHERE sj.orderId=o.id AND sj.status IN ('PENDING','PROCESSING'))
    OR o.paymentMethod='COD' AND o.status NOT IN ('COMPLETED','CANCELLED')
 ORDER BY o.id;

-- ---------------------------------------------------------------------------
-- G. MASTER DATA SNAPSHOT (save this output before any cleanup)
-- ---------------------------------------------------------------------------
SELECT 'user' t, COUNT(*) n FROM user
UNION ALL SELECT 'product', COUNT(*) FROM product
UNION ALL SELECT 'productvariant', COUNT(*) FROM productvariant
UNION ALL SELECT 'voucher', COUNT(*) FROM voucher
UNION ALL SELECT 'shippingdiscount', COUNT(*) FROM shippingdiscount
UNION ALL SELECT 'flashsale', COUNT(*) FROM flashsale
UNION ALL SELECT 'campaign', COUNT(*) FROM campaign
UNION ALL SELECT 'spinwheelcampaign', COUNT(*) FROM spinwheelcampaign
UNION ALL SELECT 'spinwheelreward', COUNT(*) FROM spinwheelreward
UNION ALL SELECT 'spinwheelspin', COUNT(*) FROM spinwheelspin
UNION ALL SELECT 'storesetting', COUNT(*) FROM storesetting
UNION ALL SELECT 'affiliateprofile', COUNT(*) FROM affiliateprofile
UNION ALL SELECT 'affiliatekyc', COUNT(*) FROM affiliatekyc
UNION ALL SELECT 'affiliatepayout', COUNT(*) FROM affiliatepayout
UNION ALL SELECT 'useraddress', COUNT(*) FROM useraddress
UNION ALL SELECT 'province', COUNT(*) FROM province
UNION ALL SELECT 'regency', COUNT(*) FROM regency
UNION ALL SELECT 'district', COUNT(*) FROM district
UNION ALL SELECT 'village', COUNT(*) FROM village
UNION ALL SELECT 'adminauditlog', COUNT(*) FROM adminauditlog;

-- Stock and counters (must be identical after cleanup).
SELECT p.id, p.name, p.sold, v.id AS variant_id, v.name AS variant_name, v.stock
  FROM product p LEFT JOIN productvariant v ON v.productId = p.id
 ORDER BY p.id, v.id;

SELECT id, code, quota, usedCount FROM voucher ORDER BY id;
SELECT id, name, quota, usedCount FROM shippingdiscount ORDER BY id;
SELECT id, name, saleStock, soldCount FROM flashsale ORDER BY id;
SELECT id, name, totalQuantity, usedQuantity FROM spinwheelreward ORDER BY id;

-- ---------------------------------------------------------------------------
-- H. WHAT EACH SCOPE WOULD DELETE (simulation, still SELECT-only)
-- ---------------------------------------------------------------------------
-- Scope "closed": COMPLETED/CANCELLED with no open refund / live commission
-- and no in-flight shipment job.
SELECT
  (SELECT COUNT(*) FROM `order`) AS orders_total,
  (SELECT COUNT(*) FROM `order` o
    WHERE o.status IN ('COMPLETED','CANCELLED')
      AND NOT EXISTS (SELECT 1 FROM refund r
                       WHERE r.orderId=o.id AND r.status IN ('PENDING','PROCESSING'))
      AND NOT EXISTS (SELECT 1 FROM affiliateconversion ac
                       WHERE ac.orderId=o.id AND ac.status IN ('PENDING','APPROVED','PAID'))
      AND NOT EXISTS (SELECT 1 FROM shipmentjob sj
                       WHERE sj.orderId=o.id AND sj.status IN ('PENDING','PROCESSING'))
  ) AS orders_closed_scope;

SELECT 'orderitem' AS child, COUNT(*) AS rows_
  FROM orderitem oi
  JOIN `order` o ON o.id = oi.orderId
 WHERE o.status IN ('COMPLETED','CANCELLED')
UNION ALL
SELECT 'refund (COMPLETED/FAILED)', COUNT(*)
  FROM refund r JOIN `order` o ON o.id = r.orderId
 WHERE o.status IN ('COMPLETED','CANCELLED')
   AND r.status IN ('COMPLETED','FAILED')
UNION ALL
SELECT 'affiliateconversion (CANCELLED/REVERSED)', COUNT(*)
  FROM affiliateconversion ac JOIN `order` o ON o.id = ac.orderId
 WHERE o.status IN ('COMPLETED','CANCELLED')
   AND ac.status IN ('CANCELLED','REVERSED')
UNION ALL
SELECT 'notification linked', COUNT(*)
  FROM notification n JOIN `order` o ON o.id = n.orderId
 WHERE o.status IN ('COMPLETED','CANCELLED');

-- ---------------------------------------------------------------------------
-- I. CONCURRENCY WATCH — run right before and right after the cleanup
-- ---------------------------------------------------------------------------
SELECT MAX(id) AS max_order_id, COUNT(*) AS orders_now,
       SUM(createdAt > (NOW() - INTERVAL 15 MINUTE)) AS created_last_15m
  FROM `order`;

-- ---------------------------------------------------------------------------
-- J. POST-CLEANUP VERIFICATION (run after, compare with G/H)
-- ---------------------------------------------------------------------------
SELECT COUNT(*) AS orders_left,
       (SELECT COUNT(*) FROM orderitem) AS orderitems_left,
       (SELECT COUNT(*) FROM refund) AS refunds_left,
       (SELECT COUNT(*) FROM affiliateconversion) AS conversions_left,
       (SELECT COUNT(*) FROM shipmentjob) AS shipment_jobs_left,
       (SELECT COUNT(*) FROM notification) AS notifications_left;

-- Orphans must all be zero.
SELECT 'orderitem' t, COUNT(*) orphans FROM orderitem x
  LEFT JOIN `order` o ON o.id=x.orderId WHERE o.id IS NULL
UNION ALL SELECT 'shipmentjob', COUNT(*) FROM shipmentjob x
  LEFT JOIN `order` o ON o.id=x.orderId WHERE o.id IS NULL
UNION ALL SELECT 'guestrecoverychallenge', COUNT(*) FROM guestrecoverychallenge x
  LEFT JOIN `order` o ON o.id=x.orderId WHERE o.id IS NULL
UNION ALL SELECT 'refund', COUNT(*) FROM refund x
  LEFT JOIN `order` o ON o.id=x.orderId WHERE o.id IS NULL
UNION ALL SELECT 'affiliateconversion', COUNT(*) FROM affiliateconversion x
  LEFT JOIN `order` o ON o.id=x.orderId WHERE o.id IS NULL;

-- Masters must equal section G exactly.
SELECT 'user' t, COUNT(*) n FROM user
UNION ALL SELECT 'product', COUNT(*) FROM product
UNION ALL SELECT 'productvariant', COUNT(*) FROM productvariant
UNION ALL SELECT 'voucher', COUNT(*) FROM voucher
UNION ALL SELECT 'shippingdiscount', COUNT(*) FROM shippingdiscount
UNION ALL SELECT 'flashsale', COUNT(*) FROM flashsale
UNION ALL SELECT 'campaign', COUNT(*) FROM campaign
UNION ALL SELECT 'spinwheelcampaign', COUNT(*) FROM spinwheelcampaign
UNION ALL SELECT 'spinwheelreward', COUNT(*) FROM spinwheelreward
UNION ALL SELECT 'spinwheelspin', COUNT(*) FROM spinwheelspin
UNION ALL SELECT 'storesetting', COUNT(*) FROM storesetting
UNION ALL SELECT 'affiliateprofile', COUNT(*) FROM affiliateprofile
UNION ALL SELECT 'affiliatekyc', COUNT(*) FROM affiliatekyc
UNION ALL SELECT 'affiliatepayout', COUNT(*) FROM affiliatepayout
UNION ALL SELECT 'adminauditlog', COUNT(*) FROM adminauditlog;
