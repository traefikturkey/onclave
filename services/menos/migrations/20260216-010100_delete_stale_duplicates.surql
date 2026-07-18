-- Delete stale duplicate YouTube content records.
-- Each record below is a confirmed duplicate with worse metadata than the original.
-- Created during re-ingestion before the resource_key dedup system existed.

-- wmIpFQdkPJQ duplicate (2026-02-10) — generic title, no metadata
DELETE content:uyeyshacj06fk7pgnsvn;

-- Sf4oD_1p88Y duplicate (2026-02-10) — generic title, no metadata
DELETE content:u0fpb8dkryc9r6jm2r2q;

-- 4_2j5wgt_ds duplicate
DELETE content:vs5kvmwpp12ulku994b3;

-- T9DB2HF4VTE duplicate
DELETE content:tjqk2zu3udixpzhjlncl;

-- rMADSuus6jg duplicate
DELETE content:rg3e4ry6x6qmgypetmi2;

-- RpvQH0r0ecM duplicate
DELETE content:tq417yl4e7aibvm6kem5;

-- QzZ97noEapA duplicate, failed pipeline
DELETE content:iy8xs1d8brupwqa39ki5;

-- Delete orphaned chunks for all deleted content records
DELETE FROM chunk WHERE content_id INSIDE [
    'uyeyshacj06fk7pgnsvn',
    'u0fpb8dkryc9r6jm2r2q',
    'vs5kvmwpp12ulku994b3',
    'tjqk2zu3udixpzhjlncl',
    'rg3e4ry6x6qmgypetmi2',
    'tq417yl4e7aibvm6kem5',
    'iy8xs1d8brupwqa39ki5'
];
