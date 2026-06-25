# POS Software Final Test Report

**Date:** June 13, 2026  
**Status:** PASS

## Automated Verification

Both the primary workspace and packaged `Akopharmah Limited POS` copy pass:

```powershell
npm test
```

The suite verifies:

- Fresh deployment bootstrap, zero opening stock, and no demonstration patients.
- Authenticated sessions, logout invalidation, role and branch enforcement, and protected static data.
- Canonical server pricing, stock bounds, discounts, purchases, transfers, write-offs, and returns.
- Workers can sell Rx-marked medicines without software prescription approval.
- Workers can record non-override interaction reviews but cannot forge pharmacist overrides.
- Legacy single-branch stock is not multiplied across branches.
- Legacy returns restore matching branch and batch stock and can be sold again.
- Empty branch deletion removes its stale batch records.
- Refunds do not inflate items sold, category revenue, top-selling units, or transaction counts.
- Checkout rejects stale stock, invalid quantities, and discounts outside 0-100%.
- Held sales retain the selected patient ID.
- Drug records retain a separate selling unit such as strip, blister pack, bottle, vial, or ampoule.
- Cost price and selling price calculate in both directions using the configured 30% markup.
- Inventory deletion removes a drug only from the selected branch; the shared drug record, other branch stock, and other branch batches remain intact.
- Directors can explicitly remove stocked products from a branch after backup and confirmation; managers receive the exact server safety reason.
- Encrypted backups, offline credential expiry, branch-scoped reports, and server role precedence.

## Static And Data Checks

- All active JavaScript parses and the generated runtime builds with 115 exported event handlers.
- 29 active text/source files are valid UTF-8 with no BOMs, replacement characters, or common mojibake signatures.
- HTML IDs are unique and every inline event handler resolves to an application function.
- Application JSON files parse successfully.
- The live database contains 5 branches, 5 users, 76 drugs, 3 customers, and 13 sales with no duplicate IDs, invalid dates, negative stock, or branch/batch stock drift.
- External CDN assets retain SHA-384 subresource-integrity hashes.

## Runtime Verification

A disposable production server passed:

- Health and persistent-storage readiness.
- Bootstrap director login and authenticated `/auth/me`, branch, and inventory access.
- Branch-scoped drug deletion hid the medicine only at the selected branch while preserving another branch's 5 units and matching batch stock.
- HTTP 200 delivery for the application, CSS, logo, public seed, module entry, generated runtime, renderer, and reports.
- Content Security Policy, `X-Frame-Options: DENY`, and no-store API responses.

The in-app visual browser could not start because the local Windows browser runner returned access denied. No live pharmacy data was modified during this audit.
