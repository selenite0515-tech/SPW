-- Idempotent data migration: administration job post (ADM) and admin employee linkage.
-- Safe to run multiple times. Application migrate() also applies equivalent logic via Node.

INSERT INTO job_posts (code, name, created_by, updated_by)
SELECT 'ADM', 'Administration (HQ)', NULL, NULL
WHERE NOT EXISTS (SELECT 1 FROM job_posts WHERE LOWER(code) = 'adm');

UPDATE employees e
SET job_post_id = jp.id, updated_at = NOW()
FROM job_posts jp
WHERE LOWER(jp.code) = 'adm'
  AND e.role = 'admin'
  AND (e.job_post_id IS DISTINCT FROM jp.id);

UPDATE payslip_signatures
SET pdf_storage_key = pdf_path
WHERE pdf_path IS NOT NULL
  AND TRIM(pdf_path) <> ''
  AND (pdf_storage_key IS NULL OR TRIM(pdf_storage_key) = '');
