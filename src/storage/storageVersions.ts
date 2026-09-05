/**
 * The one durable compatibility axis for a Yui Home.
 *
 * Version 1 is the clean baseline introduced by Yui 0.15.0: SQLite's migration
 * ledger is authoritative and the historical layout/aggregate/record-version
 * manifest is not part of the active Home. Pre-0.15.0 Homes are outside this
 * compatibility line and remain untouched.
 *
 * Runtime code reads only {@link CURRENT_STORAGE_VERSION}. The explicit
 * upgrade boundary carries every forward migration from
 * {@link MIN_SUPPORTED_STORAGE_VERSION} to the current version so one target
 * CLI can upgrade any valid Home in that interval without installing
 * intermediate Yui releases.
 */
export const MIN_SUPPORTED_STORAGE_VERSION = 1;
export const CURRENT_STORAGE_VERSION = 1;
